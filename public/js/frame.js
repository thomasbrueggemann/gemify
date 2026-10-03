// Runs inside the sandboxed game iframe. Two modes:
//
//  authority  (host screen) runs the generated rules: owns the state, applies
//             actions from local and remote seats, plays the bots, and hands the
//             parent a playerView() snapshot per seat after every change.
//  mirror     (guest screen) only renders snapshots and forwards its actions.
//
// The parent page talks to us with postMessage; see public/js/session.js.

import * as THREE from 'three'
import {OrbitControls} from 'three/addons/controls/OrbitControls.js'
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js'

const BOT_DELAY_MS = 750

const post = msg => parent.postMessage(msg, '*')

const report = (phase, err) => {
  const message = err?.message || String(err)
  post({t: 'error', phase, message, stack: err?.stack ? String(err.stack).split('\n').slice(0, 8).join('\n') : ''})
}
addEventListener('error', e => report('runtime', e.error || e.message))
addEventListener('unhandledrejection', e => report('runtime', e.reason))

const clone = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)))

let game = null       // the imported module
let renderer = null   // what createRenderer returned
let mode = null
let mirrorSeat = null // mirror: the seat this screen plays

// authority state
let state = null
let seats = []        // [{name, color, kind: 'human'|'bot', where: 'local'|'remote'}]
let v = 0
let botTimer = null

const random = Math.random

// ── Rendering ─────────────────────────────────────────────────────────

const draw = payload => {
  if (!renderer) return
  try {
    renderer.update(payload)
  } catch (err) {
    report('render', err)
  }
}

// ── Authority ─────────────────────────────────────────────────────────

const localSeats = () => seats.map((s, i) => (s.where === 'local' && s.kind === 'human' ? i : -1)).filter(i => i >= 0)
const publicPlayers = () => seats.map(({name, color, kind}) => ({name, color, kind}))

const safe = (fn, fallback) => {
  try { return fn() } catch (err) { report('rules', err); return fallback }
}

/** Seat the local screen acts for right now. */
const localMe = active => {
  const mine = localSeats()
  if (mine.length <= 1) return mine[0] ?? null
  return mine.find(i => active.includes(i)) ?? mine[0]
}

const payloadFor = (seat, active, res, error = null) => ({
  v,
  me: seat,
  view: safe(() => clone(game.playerView(clone(state), seat)), null),
  active,
  players: publicPlayers(),
  result: res,
  error,
  hotseat: false
})

const publish = (errors = {}) => {
  if (!state) return   // seats can change in the lobby, before start
  const active = safe(() => game.activePlayers(state) || [], [])
  const res = safe(() => game.result(state), null)

  // Remote seats get their own filtered view.
  const views = {}
  seats.forEach((s, i) => {
    if (s.where === 'remote') views[i] = payloadFor(i, active, res, errors[i] || null)
  })

  // The host screen: one seat, or a shared hot-seat screen that shows the full
  // state (players are physically sharing it anyway).
  const mine = localSeats()
  const me = localMe(active)
  const hotseat = mine.length > 1
  draw({
    v,
    me,
    view: hotseat ? clone(state) : safe(() => clone(game.playerView(clone(state), me)), null),
    active,
    players: publicPlayers(),
    result: res,
    error: mine.map(i => errors[i]).find(Boolean) || null,
    hotseat
  })

  post({t: 'views', v, views, state, active, result: res})
  scheduleBots(active, res)
}

const apply = (seat, action) => {
  if (!state) return
  const active = safe(() => game.activePlayers(state) || [], [])
  if (!active.includes(seat)) return publish({[seat]: 'It is not your turn.'})
  let outcome
  try {
    outcome = game.applyAction(clone(state), clone(action), {player: seat, random})
  } catch (err) {
    report('rules', err)
    return publish({[seat]: 'That move crashed the rules engine.'})
  }
  if (!outcome || outcome.error || !outcome.state) {
    return publish({[seat]: outcome?.error || 'That move is not allowed.'})
  }
  state = outcome.state
  v++
  publish()
}

const scheduleBots = (active, res) => {
  clearTimeout(botTimer)
  if (res || typeof game.botAction !== 'function') return
  const bot = active.find(i => seats[i]?.kind === 'bot')
  if (bot === undefined) return
  botTimer = setTimeout(() => {
    const action = safe(() => game.botAction(clone(state), bot, random), null)
    if (action) apply(bot, action)
  }, BOT_DELAY_MS)
}

const start = (msg) => {
  seats = msg.seats
  v = 0
  try {
    state = msg.restore ? clone(msg.restore) : game.setup({numPlayers: seats.length, random})
  } catch (err) {
    return report('rules', err)
  }
  publish()
}

// ── Boot ──────────────────────────────────────────────────────────────

const load = async msg => {
  mode = msg.mode
  mirrorSeat = msg.me ?? null
  try {
    // A data: URL gives the module its own URL without needing CORS or blobs,
    // which are awkward from an opaque origin.
    const url = `data:text/javascript;base64,${btoa(unescape(encodeURIComponent(msg.code)))}`
    game = await import(url)
  } catch (err) {
    return report('load', err)
  }
  document.getElementById('boot')?.remove()
  try {
    renderer = game.createRenderer({
      THREE,
      addons: {OrbitControls, RoundedBoxGeometry},
      canvasHost: document.getElementById('canvas'),
      uiHost: document.getElementById('ui'),
      photos: (msg.photos || []).map(p => ({kind: p.kind, url: URL.createObjectURL(p.blob)})),
      sendAction: action => {
        if (mode === 'mirror') return post({t: 'action', action: clone(action)})
        const active = safe(() => game.activePlayers(state) || [], [])
        const me = localMe(active)
        if (me !== null) apply(me, action)
      }
    })
  } catch (err) {
    return report('render', err)
  }
  post({t: 'loaded', meta: clone(game.meta || {})})
}

addEventListener('message', e => {
  if (e.source !== parent) return
  const msg = e.data || {}
  if (msg.t === 'load') load(msg)
  else if (msg.t === 'start' && mode === 'authority') start(msg)
  else if (msg.t === 'remote' && mode === 'authority') apply(msg.seat, msg.action)
  else if (msg.t === 'seats' && mode === 'authority') { seats = msg.seats; publish() }
  else if (msg.t === 'view' && mode === 'mirror') draw({...msg.payload, me: mirrorSeat ?? msg.payload.me})
})

post({t: 'ready'})
