// The main Gemify page. One browser is the host: it owns the room, collects
// the phone's photos, asks the server to build the game, configures seats and
// runs the rules (in the authority iframe). Other browsers join as guests.
//
// Authority model: the host runs the rules and sends each
// guest a playerView() snapshot; guests only send intents ({action}). The host
// checks which seat an intent comes from, so a guest can only move for itself.

import {openRoom, makeCode, normaliseCode, clientId} from './net.js'
import {shrinkPhoto, blobToBase64, qrDataUrl} from './media.js'
import {createSession} from './session.js'
import {renderMarkdown, escapeHtml} from './markdown.js'

const $ = sel => document.querySelector(sel)
const $$ = sel => [...document.querySelectorAll(sel)]

const JOIN_TIMEOUT_MS = 30000
const SEAT_COLORS = ['#e4572e', '#29a3ff', '#f3c623', '#4cb944', '#b56cff', '#ff8fab', '#20c997', '#ff9f1c']

const app = {
  config: {},
  room: null,
  code: null,
  role: null,            // 'host' | 'guest'
  peers: new Map(),      // peerId → {role, name, client}
  // host: capture
  photos: [],            // {id, kind, blob, url, from}
  phoneNotes: '',
  // host: game
  game: null,            // meta from the server
  gameCode: null,        // module source
  gameMeta: null,        // the module's exported meta
  seats: [],             // {name, kind: 'human'|'bot', where: 'local'|'remote', client?}
  started: false,
  session: null,
  lastViews: {},         // seat → last payload, re-sent on reconnect
  build: null,           // EventSource
  // guest
  mySeat: null,
  guestGame: null,
  lastView: null
}

// ── Small UI helpers ──────────────────────────────────────────────────

const show = name => {
  $$('.view').forEach(v => { v.hidden = v.id !== `v-${name}` })
  document.body.dataset.view = name
  scrollTo(0, 0)
}

let toastTimer = null
const toast = (text, ms = 3200) => {
  const el = $('#toast')
  el.textContent = text
  el.classList.add('on')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('on'), ms)
}

const setStatus = (el, text, state = 'wait') => {
  el.innerHTML = `<span class="dot ${state}"></span> ${escapeHtml(text)}`
}

const publicBase = () => app.config.publicUrl || location.origin

const myName = () => {
  try { return localStorage.getItem('gemify:name') || '' } catch { return '' }
}
const saveName = n => { try { localStorage.setItem('gemify:name', n) } catch {} }

const api = async (url, opts = {}) => {
  const res = await fetch(url, {
    ...opts,
    headers: opts.body ? {'content-type': 'application/json'} : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

// ── Room (host side) ──────────────────────────────────────────────────

const ensureHostRoom = async () => {
  if (app.room && app.role === 'host') return
  leaveRoom()
  app.role = 'host'
  app.code = makeCode()
  $('#room-chip').hidden = false
  $('#room-chip').textContent = `Room ${app.code}`
  app.room = await openRoom({
    code: app.code,
    onPeerJoin: id => app.room.send('hi', {role: 'host'}, {target: id}).catch(() => {}),
    onPeerLeave: id => hostPeerLeft(id),
    onError: err => toast(`Room error: ${err.message}`)
  })
  const room = app.room

  room.on('hi', (msg, {peerId}) => {
    app.peers.set(peerId, {role: msg.role, name: String(msg.name || '').slice(0, 20), client: msg.client})
    if (msg.role === 'scanner') phoneJoined(peerId)
    if (msg.role === 'player') playerJoined(peerId)
  })

  // Photos from the phone: binary + metadata {id, kind}.
  room.onReceiveProgress('photo', (pct, {peerId, metadata}) => {
    if (app.peers.get(peerId)?.role !== 'scanner' || !metadata) return
    pendingThumb(metadata.id, metadata.kind, pct)
  })
  room.on('photo', (data, {peerId, metadata}) => {
    if (app.peers.get(peerId)?.role !== 'scanner' || !metadata?.id) return
    if (!['rules', 'components'].includes(metadata.kind)) return
    const blob = new Blob([data], {type: 'image/jpeg'})
    addPhoto({id: metadata.id, kind: metadata.kind, blob, from: 'phone'})
    room.send('ack', {id: metadata.id}, {target: peerId}).catch(() => {})
  })
  room.on('rmphoto', ({id}, {peerId}) => {
    if (app.peers.get(peerId)?.role === 'scanner') removePhoto(id)
  })
  room.on('notes', ({text}, {peerId}) => {
    if (app.peers.get(peerId)?.role !== 'scanner') return
    app.phoneNotes = String(text || '').slice(0, 2000)
    $('#notes').value = app.phoneNotes
  })
  room.on('done', (_, {peerId}) => {
    if (app.peers.get(peerId)?.role !== 'scanner') return
    if (!app.build && document.body.dataset.view === 'capture') startBuild()
  })

  // Intents from guests: only for the seat bound to their client id.
  room.on('act', ({action}, {peerId}) => {
    if (!app.started || !app.session) return
    const seat = seatOfPeer(peerId)
    if (seat < 0) return
    app.session.remoteAction(seat, action)
  })
  room.on('name', ({name}, {peerId}) => {
    const p = app.peers.get(peerId)
    if (!p) return
    p.name = String(name || '').slice(0, 20)
    const seat = seatOfPeer(peerId)
    if (seat >= 0) app.seats[seat].name = p.name || `Player ${seat + 1}`
    seatsChanged()
  })
}

const hostPeerLeft = id => {
  const p = app.peers.get(id)
  app.peers.delete(id)
  if (!p) return
  if (p.role === 'scanner') {
    setStatus($('#phone-status'), 'Phone disconnected. Scan again to reconnect.', 'warn')
  }
  if (p.role === 'player') {
    toast(`${p.name || 'A player'} left the room.`)
    seatsChanged()
  }
}

const leaveRoom = () => {
  app.room?.leave()
  app.room = null
  app.peers.clear()
  app.role = null
  $('#room-chip').hidden = true
}

const sendToScanners = (channel, data) => {
  const targets = [...app.peers].filter(([, p]) => p.role === 'scanner').map(([id]) => id)
  if (targets.length) app.room?.send(channel, data, {target: targets}).catch(() => {})
}

// ── Capture ───────────────────────────────────────────────────────────

const openCapture = async () => {
  app.photos.forEach(p => URL.revokeObjectURL(p.url))
  app.photos = []
  app.phoneNotes = ''
  $('#notes').value = ''
  renderThumbs()
  show('capture')
  setStatus($('#phone-status'), 'Waiting for your phone…')
  try {
    await ensureHostRoom()
  } catch (err) {
    setStatus($('#phone-status'), err.message, 'bad')
    return
  }
  $('#room-code').textContent = app.code
  const url = `${publicBase()}/scan.html?room=${app.code}`
  $('#phone-link').href = url
  $('#phone-link').textContent = url
  $('#qr-phone').src = await qrDataUrl(url)

  const warn = $('#phone-warn')
  const localOnly = /^(localhost|127\.)/.test(new URL(publicBase()).hostname)
  warn.hidden = !localOnly
  if (localOnly) warn.textContent = 'This link points at localhost, which your phone cannot reach. Start the server with HTTPS on your LAN (default) or set PUBLIC_URL to a tunnel.'
}

const phoneJoined = peerId => {
  setStatus($('#phone-status'), 'Phone connected', 'ok')
  // Let the phone reconcile what we already have (e.g. after it reloaded).
  app.room.send('status', {
    stage: app.build ? 'build' : app.game && document.body.dataset.view !== 'capture' ? 'ready' : 'collect',
    have: app.photos.filter(p => p.from === 'phone').map(p => p.id),
    title: app.game?.title
  }, {target: peerId}).catch(() => {})
}

const pendingThumb = (id, kind, pct) => {
  let el = document.querySelector(`[data-photo="${CSS.escape(id)}"]`)
  if (!el) {
    el = document.createElement('figure')
    el.className = 'thumb loading'
    el.dataset.photo = id
    el.innerHTML = '<div class="pct"></div>'
    $(`#thumbs-${kind}`)?.append(el)
  }
  const pctEl = el.querySelector('.pct')
  if (pctEl) pctEl.textContent = `${Math.round(pct * 100)}%`
}

const addPhoto = photo => {
  if (app.photos.some(p => p.id === photo.id)) return
  photo.url = URL.createObjectURL(photo.blob)
  app.photos.push(photo)
  renderThumbs()
}

const removePhoto = id => {
  const i = app.photos.findIndex(p => p.id === id)
  if (i < 0) return
  URL.revokeObjectURL(app.photos[i].url)
  app.photos.splice(i, 1)
  renderThumbs()
}

const renderThumbs = () => {
  for (const kind of ['rules', 'components']) {
    const list = app.photos.filter(p => p.kind === kind)
    $(`#count-${kind}`).textContent = list.length
    $(`#thumbs-${kind}`).replaceChildren(...list.map((p, i) => {
      const fig = document.createElement('figure')
      fig.className = 'thumb'
      fig.dataset.photo = p.id
      fig.innerHTML = `<img alt="${kind} photo ${i + 1}"><figcaption>${i + 1}</figcaption><button class="x" title="Remove">×</button>`
      fig.querySelector('img').src = p.url
      fig.querySelector('.x').onclick = () => {
        removePhoto(p.id)
        if (p.from === 'phone') sendToScanners('rmphoto', {id: p.id})
      }
      return fig
    }))
  }
  $('#btn-build').disabled = !app.photos.some(p => p.kind === 'rules')
}

// ── Build with Claude ─────────────────────────────────────────────────

const startBuild = async () => {
  if (app.build) return
  show('build')
  resetBuildView('Claude is building your game')
  sendToScanners('status', {stage: 'build', text: 'Uploading photos…'})
  buildStage('Uploading photos…')
  try {
    const photos = await Promise.all(app.photos.map(async p => ({
      kind: p.kind,
      mediaType: 'image/jpeg',
      data: await blobToBase64(p.blob)
    })))
    const game = await api('/api/games', {method: 'POST', body: {photos, notes: $('#notes').value.trim()}})
    followBuild(game.id)
  } catch (err) {
    buildFailed(err.message)
  }
}

const resetBuildView = title => {
  $('#build-title').textContent = title
  $('#build-thinking').textContent = ''
  $('#build-checks').replaceChildren()
  $('#build-meta').textContent = ''
  $('#build-actions').hidden = true
  $('#build-bar').style.width = '4%'
  $('#v-build').classList.remove('failed')
}

const buildStage = text => {
  $('#build-stage').textContent = text
  sendToScanners('status', {stage: 'build', text})
}

/** Follow a generation or repair job over Server-Sent Events. */
const followBuild = (id, {onDone} = {}) => {
  app.build?.close()
  const es = new EventSource(`/api/games/${id}/events`)
  app.build = es
  let thinking = ''
  let chars = 0
  es.onmessage = e => {
    const ev = JSON.parse(e.data)
    if (ev.type === 'stage') buildStage(ev.text)
    if (ev.type === 'thinking') {
      thinking = (thinking + ev.text).slice(-1800)
      $('#build-thinking').textContent = thinking
    }
    if (ev.type === 'progress') {
      chars = ev.chars
      // A typical game module is 25–60k characters; the bar is an estimate.
      $('#build-bar').style.width = `${Math.min(92, 10 + (chars / 50000) * 80)}%`
      $('#build-meta').textContent = `${Math.round(chars / 1000)}k characters of game written`
    }
    if (ev.type === 'verify') {
      const li = document.createElement('li')
      li.className = ev.ok ? 'ok' : 'bad'
      li.textContent = ev.ok
        ? `Rules test passed — ${ev.stats?.gamesFinished ?? 0} bot games played to the end`
        : `Rules test found ${ev.problems.length} problem(s): ${ev.problems[0]?.split('\n')[0]}`
      $('#build-checks').append(li)
    }
    if (ev.type === 'done') {
      es.close()
      app.build = null
      $('#build-bar').style.width = '100%'
      sendToScanners('status', {stage: 'ready', title: ev.game.title})
      ;(onDone || openLobby)(ev.game)
    }
    if (ev.type === 'error') {
      es.close()
      app.build = null
      buildFailed(ev.message, id)
    }
  }
  es.onerror = () => {
    // The stream closes normally after done/error; anything else: retry quietly.
    if (es.readyState === EventSource.CLOSED && app.build === es) {
      app.build = null
      setTimeout(() => followBuild(id, {onDone}), 1500)
    }
  }
}

const buildFailed = (message, id) => {
  app.build = null
  $('#v-build').classList.add('failed')
  $('#build-title').textContent = 'The build did not work'
  $('#build-stage').textContent = message
  $('#build-actions').hidden = false
  $('#btn-retry').hidden = !id && !app.photos.length
  $('#btn-retry').onclick = async () => {
    // Re-run from the photos the server already has; only upload if it never got them.
    if (!id) return startBuild()
    resetBuildView('Claude is building your game')
    try {
      await api(`/api/games/${id}/retry`, {method: 'POST'})
      followBuild(id)
    } catch (err) {
      buildFailed(err.message, id)
    }
  }
  sendToScanners('status', {stage: 'error', text: message})
}

// ── Lobby ─────────────────────────────────────────────────────────────

const openLobby = async game => {
  app.session?.destroy()
  app.session = null
  app.started = false
  app.lastViews = {}
  app.game = game
  show('lobby')
  $('#lobby-title').textContent = game.title
  $('#lobby-rules').innerHTML = renderMarkdown(game.summary || '')
  const verify = $('#lobby-verify')
  verify.hidden = !game.verify || game.verify.ok
  if (!verify.hidden) {
    verify.innerHTML = `<strong>The automated rules test still reports problems.</strong> It may play fine, or you may hit a bug — then use “Fix it with Claude”.<pre>${escapeHtml(game.verify.problems.slice(0, 3).join('\n\n'))}</pre>`
  }

  try {
    await ensureHostRoom()
  } catch (err) {
    toast(err.message)
  }
  const invite = `${publicBase()}/?join=${app.code}`
  $$('.room-code-copy').forEach(el => { el.textContent = app.code })
  $('#qr-invite').src = await qrDataUrl(invite)
  $('#btn-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(invite); toast('Invite link copied.') } catch { toast(invite, 9000) }
  }

  // Load the module now so the seat range comes from its meta.
  try {
    app.gameCode = await fetch(`/api/games/${game.id}/game.js?v=${game.version}`).then(r => {
      if (!r.ok) throw new Error('The game file is missing.')
      return r.text()
    })
  } catch (err) {
    toast(err.message)
    return
  }
  mountAuthority()
}

/** The host's game iframe: loaded in the lobby, started with the seats. */
const mountAuthority = () => {
  app.gameMeta = null
  app.session?.destroy()
  app.session = createSession({
    container: $('#game-host'),
    code: app.gameCode,
    mode: 'authority',
    photos: (app.game.photos || []).map((p, i) => ({url: `/api/games/${app.game.id}/photos/${i}`, kind: p.kind})),
    onEvent: hostFrameEvent
  })
}

const hostFrameEvent = (type, data) => {
  if (type === 'loaded') {
    app.gameMeta = data
    if (!app.started) defaultSeats()
  }
  if (type === 'views') {
    for (const [seat, payload] of Object.entries(data.views)) {
      app.lastViews[seat] = payload
      const peer = peerOfSeat(Number(seat))
      if (peer) app.room?.send('view', payload, {target: peer}).catch(() => {})
    }
  }
  if (type === 'error') showCrash(data)
}

const range = () => {
  const m = app.gameMeta || {}
  const min = Math.max(1, m.minPlayers | 0 || 1)
  return {min, max: Math.max(min, m.maxPlayers | 0 || min)}
}

const defaultSeats = () => {
  const {min} = range()
  const bots = !!app.gameMeta?.supportsBots
  app.seats = [{name: myName() || 'You', kind: 'human', where: 'local'}]
  const players = [...app.peers].filter(([, p]) => p.role === 'player')
  while (app.seats.length < Math.max(min, Math.min(range().max, players.length + 1))) {
    app.seats.push({name: '', kind: bots ? 'bot' : 'human', where: 'local'})
  }
  for (const [peerId] of players) playerJoined(peerId, {quiet: true})
  seatsChanged()
}

const seatLabel = (s, i) => {
  if (s.kind === 'bot') return `Bot ${i + 1}`
  if (s.where === 'remote') return s.client ? (s.name || `Player ${i + 1}`) : 'Waiting for someone to join…'
  return s.name || (i === 0 ? 'You' : `Player ${i + 1} (same screen)`)
}

const seatColor = i => app.gameMeta?.playerColors?.[i] || SEAT_COLORS[i % SEAT_COLORS.length]

// What everyone (players, the game) sees; "You" only makes sense on the host.
const publicSeats = () => app.seats.map((s, i) => ({
  name: i === 0 ? (myName() || 'Host') : seatLabel(s, i),
  color: seatColor(i),
  kind: s.kind,
  where: s.where,
  client: s.client || null
}))

const renderSeats = () => {
  const {min, max} = range()
  $('#seat-n').textContent = app.seats.length
  $('#seat-range').textContent = min === max ? `(exactly ${min})` : `(${min}–${max})`
  $('#seat-minus').disabled = app.started || app.seats.length <= min
  $('#seat-plus').disabled = app.started || app.seats.length >= max
  const bots = !!app.gameMeta?.supportsBots
  $('#seats').replaceChildren(...app.seats.map((s, i) => {
    const li = document.createElement('li')
    li.style.setProperty('--seat', seatColor(i))
    const online = s.where === 'remote'
    const connected = online && s.client && [...app.peers.values()].some(p => p.client === s.client)
    li.innerHTML = `
      <span class="swatch"></span>
      <span class="seat-name">${escapeHtml(seatLabel(s, i))}${online && s.client && !connected ? ' <em>(offline)</em>' : ''}</span>
      ${i === 0 ? '<span class="muted small">host</span>' : `
      <select ${app.started ? 'disabled' : ''} aria-label="Seat ${i + 1}">
        <option value="local" ${s.kind === 'human' && s.where === 'local' ? 'selected' : ''}>Same screen</option>
        <option value="remote" ${online ? 'selected' : ''}>Online player</option>
        ${bots ? `<option value="bot" ${s.kind === 'bot' ? 'selected' : ''}>Bot</option>` : ''}
      </select>`}`
    li.querySelector('select')?.addEventListener('change', e => {
      const v = e.target.value
      s.kind = v === 'bot' ? 'bot' : 'human'
      s.where = v === 'remote' ? 'remote' : 'local'
      if (v !== 'remote') delete s.client
      // Fill the seat from players already waiting.
      if (v === 'remote') for (const [peerId] of app.peers) playerJoined(peerId, {quiet: true})
      seatsChanged()
    })
    return li
  }))
  const waiting = app.seats.some(s => s.where === 'remote' && !s.client)
  $('#btn-start').disabled = !app.gameMeta || app.started
  $('#btn-start').textContent = waiting ? '▶ Start (empty online seats become bots)' : '▶ Start game'
}

/** Seats changed: re-render and tell every player. */
const seatsChanged = () => {
  if (!app.game) return
  renderSeats()
  if (app.started) app.session?.setSeats(publicSeats())
  for (const [peerId, p] of app.peers) {
    if (p.role !== 'player') continue
    app.room?.send('lobby', {
      game: {id: app.game.id, version: app.game.version, title: app.game.title, summary: app.game.summary, photos: app.game.photos || []},
      seats: publicSeats(),
      started: app.started,
      yourSeat: app.seats.findIndex(s => s.where === 'remote' && s.client === p.client)
    }, {target: peerId}).catch(() => {})
  }
}

const seatOfPeer = peerId => {
  const client = app.peers.get(peerId)?.client
  return client ? app.seats.findIndex(s => s.where === 'remote' && s.client === client) : -1
}
const peerOfSeat = seat => {
  const client = app.seats[seat]?.client
  return client ? [...app.peers].find(([, p]) => p.client === client)?.[0] : null
}

const playerJoined = (peerId, {quiet = false} = {}) => {
  const p = app.peers.get(peerId)
  if (!p || p.role !== 'player' || !app.game) return
  // Same browser coming back: same seat.
  let seat = app.seats.findIndex(s => s.where === 'remote' && s.client === p.client)
  if (seat < 0) seat = app.seats.findIndex(s => s.where === 'remote' && !s.client)
  if (seat < 0 && !app.started && app.seats.length < range().max) {
    app.seats.push({kind: 'human', where: 'remote'})
    seat = app.seats.length - 1
  }
  if (seat < 0 && !app.started) {
    // Turn a bot or same-screen seat into an online seat for them.
    seat = app.seats.findIndex((s, i) => i > 0 && s.where !== 'remote')
    if (seat >= 0) Object.assign(app.seats[seat], {kind: 'human', where: 'remote'})
  }
  if (seat >= 0) {
    app.seats[seat].client = p.client
    app.seats[seat].name = p.name
    if (!quiet) toast(`${p.name || 'A player'} joined.`)
  } else if (!quiet) {
    toast(`${p.name || 'Someone'} joined, but every seat is taken.`)
  }
  seatsChanged()
  if (app.started && seat >= 0 && app.lastViews[seat]) {
    app.room.send('view', app.lastViews[seat], {target: peerId}).catch(() => {})
  }
}

const startGame = () => {
  if (!app.gameMeta) return
  // Nobody showed up for an online seat: a bot takes it (or the host's screen).
  for (const s of app.seats) {
    if (s.where === 'remote' && !s.client) Object.assign(s, app.gameMeta.supportsBots ? {kind: 'bot', where: 'local'} : {kind: 'human', where: 'local'})
  }
  app.started = true
  app.lastViews = {}
  seatsChanged()
  app.session.start(publicSeats())
  enterPlay(app.game.title, true)
}

// ── Play ──────────────────────────────────────────────────────────────

const enterPlay = (title, host) => {
  show('play')
  $('#play-title').textContent = title
  $('#btn-restart').hidden = !host
  $('#btn-invite').hidden = !host
  $('#crash').hidden = true
  app.session?.focus()
}

let lastCrash = null
const showCrash = err => {
  console.error('[game]', err)
  lastCrash = err
  $('#crash-msg').textContent = `${err.message}`.slice(0, 240)
  $('#btn-fix').hidden = app.role !== 'host' || !!app.game?.demo
  $('#crash').hidden = false
}

const fixWithClaude = async () => {
  if (!lastCrash || !app.game) return
  $('#crash').hidden = true
  show('build')
  resetBuildView('Claude is fixing the bug')
  try {
    await api(`/api/games/${app.game.id}/repair`, {method: 'POST', body: {
      error: `${lastCrash.message}\n${lastCrash.stack || ''}`,
      context: `Happened during: ${lastCrash.phase}. Players: ${app.seats.length}.`,
      version: app.game.version
    }})
    followBuild(app.game.id, {onDone: game => {
      toast('Fixed! The game restarts with the new version.')
      openLobby(game).then(() => seatsChanged())
    }})
  } catch (err) {
    buildFailed(err.message)
  }
}

// ── Guest ─────────────────────────────────────────────────────────────

const joinRoom = async rawCode => {
  const code = normaliseCode(rawCode)
  if (code.length !== 6) return toast('Room codes have 6 characters.')
  leaveRoom()
  app.role = 'guest'
  app.code = code
  show('guest')
  $('#guest-title').textContent = `Room ${code}`
  $('#guest-name').value = myName()
  $('#room-chip').hidden = false
  $('#room-chip').textContent = `Room ${code}`
  setStatus($('#guest-status'), 'Connecting to the room…')

  const timeout = setTimeout(() => {
    if (!app.guestGame) setStatus($('#guest-status'), 'Still looking for the host… check the code, or ask them to keep Gemify open.', 'warn')
  }, JOIN_TIMEOUT_MS)

  const hello = id => app.room?.send('hi', {role: 'player', name: myName(), client: clientId}, {target: id}).catch(() => {})
  try {
    app.room = await openRoom({
      code,
      onPeerJoin: hello,
      onPeerLeave: id => {
        if (app.peers.get(id)?.role === 'host') {
          setStatus($('#guest-status'), 'The host left. Waiting for them to come back…', 'warn')
          toast('The host disconnected.')
        }
        app.peers.delete(id)
      },
      onError: err => setStatus($('#guest-status'), err.message, 'bad')
    })
  } catch (err) {
    clearTimeout(timeout)
    return setStatus($('#guest-status'), err.message, 'bad')
  }

  app.room.on('hi', (msg, {peerId}) => {
    if (msg.role === 'host') app.peers.set(peerId, {role: 'host'})
  })
  app.room.on('lobby', async (msg, {peerId}) => {
    if (app.peers.get(peerId)?.role !== 'host') return
    clearTimeout(timeout)
    app.mySeat = msg.yourSeat >= 0 ? msg.yourSeat : null
    const fresh = !app.guestGame || app.guestGame.id !== msg.game.id || app.guestGame.version !== msg.game.version
    app.guestGame = msg.game
    $('#guest-title').textContent = msg.game.title
    setStatus($('#guest-status'),
      app.mySeat === null ? 'Connected, but all seats are taken.' : msg.started ? 'The game is on!' : 'Connected. Waiting for the host to start…',
      app.mySeat === null ? 'warn' : 'ok')
    $('#guest-seats').replaceChildren(...msg.seats.map((s, i) => {
      const li = document.createElement('li')
      li.style.setProperty('--seat', s.color)
      li.innerHTML = `<span class="swatch"></span><span class="seat-name">${escapeHtml(s.name)}${i === app.mySeat ? ' <strong>(you)</strong>' : ''}</span>`
      return li
    }))
    if (msg.started && app.mySeat !== null) {
      if (fresh || !app.session) await mountMirror()
      else if (document.body.dataset.view !== 'play') enterPlay(msg.game.title, false)
    } else if (!msg.started && document.body.dataset.view === 'play') show('guest')
  })
  app.room.on('view', (payload, {peerId}) => {
    if (app.peers.get(peerId)?.role !== 'host') return
    app.lastView = payload
    app.session?.view(payload)
  })
}

const mountMirror = async () => {
  const g = app.guestGame
  let code
  try {
    code = await fetch(`/api/games/${g.id}/game.js?v=${g.version}`).then(r => {
      if (!r.ok) throw new Error('Could not download the game from the server.')
      return r.text()
    })
  } catch (err) {
    return setStatus($('#guest-status'), err.message, 'bad')
  }
  app.session?.destroy()
  app.session = createSession({
    container: $('#game-host'),
    code,
    mode: 'mirror',
    me: app.mySeat,
    photos: (g.photos || []).map((p, i) => ({url: `/api/games/${g.id}/photos/${i}`, kind: p.kind})),
    onEvent: (type, data) => {
      if (type === 'action') app.room?.send('act', {action: data}).catch(() => {})
      if (type === 'error') showCrash(data)
    }
  })
  // A snapshot may have arrived while the code was downloading.
  if (app.lastView) app.session.view(app.lastView)
  enterPlay(g.title, false)
}

// ── Home ──────────────────────────────────────────────────────────────

const loadGames = async () => {
  const el = $('#games')
  let games = []
  try { games = await api('/api/games') } catch (err) {
    el.innerHTML = `<p class="warn">Could not reach the server: ${escapeHtml(err.message)}</p>`
    return
  }
  el.replaceChildren(...games.map(g => {
    const card = document.createElement('article')
    card.className = `game-card ${g.status}`
    const when = g.createdAt ? new Date(g.createdAt).toLocaleDateString(undefined, {day: 'numeric', month: 'short'}) : ''
    const thumb = g.photos?.findIndex(p => p.kind === 'components')
    card.innerHTML = `
      <div class="cover">${g.photos?.length ? `<img alt="" loading="lazy" src="/api/games/${g.id}/photos/${thumb >= 0 ? thumb : 0}">` : '<span>🎲</span>'}</div>
      <div class="body">
        <h3>${escapeHtml(g.title)}</h3>
        <p class="muted small">${g.demo ? 'Built in' : escapeHtml(when)} · ${{ready: 'ready', generating: 'building…', repairing: 'being fixed…', failed: 'failed'}[g.status] || g.status}</p>
      </div>
      <button class="btn small ${g.status === 'ready' ? 'primary' : ''}">${g.status === 'ready' ? 'Play' : g.status === 'failed' ? 'Details' : 'Watch'}</button>`
    card.querySelector('button').onclick = () => {
      history.replaceState(null, '', `/?game=${g.id}`)
      if (g.status === 'ready') openLobby(g)
      else {
        show('build')
        resetBuildView(g.status === 'failed' ? 'This build failed' : 'Claude is building this game')
        followBuild(g.id)
      }
    }
    return card
  }))
}

const goHome = () => {
  app.build?.close()
  app.build = null
  app.session?.destroy()
  app.session = null
  app.started = false
  app.game = null
  app.guestGame = null
  if (app.role === 'guest') leaveRoom()
  history.replaceState(null, '', '/')
  show('home')
  loadGames()
}

// ── Wiring ────────────────────────────────────────────────────────────

const wire = () => {
  $('#btn-new').onclick = openCapture
  $('#form-join').onsubmit = e => {
    e.preventDefault()
    joinRoom($('#join-code').value)
  }
  $$('[data-go="home"]').forEach(b => { b.onclick = goHome })
  $('#btn-build').onclick = startBuild
  $$('.desk-upload input[type=file]').forEach(input => {
    input.onchange = async () => {
      for (const file of input.files) {
        try {
          addPhoto({id: makeCode(8), kind: input.dataset.kind, blob: await shrinkPhoto(file), from: 'local'})
        } catch (err) {
          toast(`Skipped ${file.name}: ${err.message}`)
        }
      }
      input.value = ''
    }
  })
  $('#notes').oninput = e => { app.phoneNotes = e.target.value }

  $('#seat-minus').onclick = () => {
    if (app.seats.length > range().min) app.seats.pop()
    seatsChanged()
  }
  $('#seat-plus').onclick = () => {
    if (app.seats.length < range().max) app.seats.push(app.gameMeta?.supportsBots ? {kind: 'bot', where: 'local'} : {kind: 'human', where: 'local'})
    seatsChanged()
  }
  $('#btn-start').onclick = startGame

  $('#btn-exit').onclick = () => {
    if (app.role === 'host' && app.game) {
      app.started = false
      openLobby(app.game).then(() => seatsChanged())
    } else goHome()
  }
  $('#btn-restart').onclick = () => {
    if (!confirm('Restart the game from the beginning?')) return
    app.lastViews = {}
    app.session.start(publicSeats())
  }
  $('#btn-invite').onclick = () => {
    navigator.clipboard?.writeText(`${publicBase()}/?join=${app.code}`).then(() => toast('Invite link copied.'), () => {})
  }
  $('#btn-rules').onclick = () => {
    const g = app.game || app.guestGame
    $('#dlg-rules-body').innerHTML = `<h2>${escapeHtml(g?.title || '')}</h2>${renderMarkdown(g?.summary || '')}`
    $('#dlg-rules').showModal()
  }
  $('#btn-fix').onclick = fixWithClaude
  $('#btn-crash-close').onclick = () => { $('#crash').hidden = true }

  $('#guest-name').onchange = e => {
    const name = e.target.value.trim().slice(0, 20)
    saveName(name)
    app.room?.send('name', {name}).catch(() => {})
  }
}

const boot = async () => {
  wire()
  try {
    app.config = await api('/api/config')
    $('#cred-warn').hidden = app.config.credentials
  } catch {}

  const q = new URLSearchParams(location.search)
  if (q.get('join')) return joinRoom(q.get('join'))
  if (q.get('game')) {
    try {
      const g = await api(`/api/games/${encodeURIComponent(q.get('game'))}`)
      if (g.status === 'ready') return openLobby(g)
      show('build')
      resetBuildView('Claude is building this game')
      return followBuild(g.id)
    } catch {}
  }
  show('home')
  loadGames()
}

addEventListener('beforeunload', () => app.room?.leave())
boot()
