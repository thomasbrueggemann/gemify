// Headless check of a generated game module. Runs in a child process under
// Node's permission model (see lib/verify.js): it may read the module and
// nothing else. Prints one JSON line: { ok, problems: [...], stats }.

import {pathToFileURL} from 'node:url'

const GAMES_PER_COUNT = 3
const MAX_STEPS = 3000

const problems = []
const stats = {playerCounts: [], gamesFinished: 0, gamesPlayed: 0, steps: 0}

const mulberry32 = seed => () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const clone = v => JSON.parse(JSON.stringify(v))

const fail = (msg, err) => {
  if (problems.length >= 12) return
  problems.push(err ? `${msg}\n${(err.stack || String(err)).split('\n').slice(0, 6).join('\n')}` : msg)
}

// Only plain JSON values: no undefined, NaN, Maps, Sets, class instances, cycles.
const firstNonJson = (v, path = '$', seen = new Set()) => {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return null
  if (typeof v === 'number') return Number.isFinite(v) ? null : `${path} is ${v}`
  if (typeof v !== 'object') return `${path} is a ${typeof v}`
  if (seen.has(v)) return `${path} is a cycle`
  seen.add(v)
  const proto = Object.getPrototypeOf(v)
  if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) {
    return `${path} is a ${v.constructor?.name || 'non-plain object'}`
  }
  for (const [k, x] of Object.entries(v)) {
    const bad = firstNonJson(x, Array.isArray(v) ? `${path}[${k}]` : `${path}.${k}`, seen)
    if (bad) return bad
  }
  seen.delete(v)
  return null
}

const serialisable = (value, what) => {
  const bad = firstNonJson(value)
  if (bad) fail(`${what} is not plain JSON: ${bad}`)
  return !bad
}

const out = () => {
  process.stdout.write(JSON.stringify({ok: problems.length === 0, problems, stats}) + '\n')
  process.exit(0)
}

const run = async () => {
  let g
  try {
    g = await import(pathToFileURL(process.argv[2]).href)
  } catch (err) {
    fail('The module failed to load (syntax error, import, or DOM access at top level)', err)
    return out()
  }

  for (const name of ['setup', 'activePlayers', 'applyAction', 'result', 'playerView', 'createRenderer']) {
    if (typeof g[name] !== 'function') fail(`Missing exported function ${name}()`)
  }
  const meta = g.meta
  if (!meta || typeof meta !== 'object') fail('Missing exported meta object')
  if (problems.length) return out()

  const min = meta.minPlayers | 0
  const max = meta.maxPlayers | 0
  if (min < 1 || max < min || max > 12) {
    fail(`meta.minPlayers/maxPlayers are invalid (${meta.minPlayers}..${meta.maxPlayers})`)
    return out()
  }
  const bots = typeof g.botAction === 'function'
  if (meta.supportsBots && !bots) fail('meta.supportsBots is true but botAction() is not exported')

  for (let n = min; n <= max; n++) {
    stats.playerCounts.push(n)
    for (let game = 0; game < (bots ? GAMES_PER_COUNT : 1); game++) {
      const random = mulberry32(n * 1000 + game + 1)
      let state
      try {
        state = g.setup({numPlayers: n, random})
      } catch (err) {
        fail(`setup({numPlayers: ${n}}) threw`, err)
        break
      }
      if (!serialisable(state, `setup() state for ${n} players`)) break

      try {
        for (let p = 0; p < n; p++) serialisable(g.playerView(clone(state), p), `playerView(state, ${p})`)
      } catch (err) {
        fail(`playerView() threw for ${n} players`, err)
      }

      // An unknown action must be rejected with { error }, not a crash.
      if (game === 0) {
        try {
          const r = g.applyAction(clone(state), {type: '__gemify_probe__'}, {player: 0, random})
          if (!r || (!r.error && !r.state)) fail('applyAction() must return { state } or { error }')
          else if (!r.error) fail('applyAction() accepted a nonsense action {type: "__gemify_probe__"}; it must return { error }')
        } catch (err) {
          fail('applyAction() threw on an unknown action instead of returning { error }', err)
        }
      }

      if (!bots) continue
      stats.gamesPlayed++
      let steps = 0
      for (; steps < MAX_STEPS; steps++) {
        let res, active
        try {
          res = g.result(state)
          if (res) break
          active = g.activePlayers(state)
        } catch (err) {
          fail(`result()/activePlayers() threw (${n} players, step ${steps})`, err)
          break
        }
        if (!Array.isArray(active) || active.length === 0) {
          fail(`activePlayers() returned ${JSON.stringify(active)} while result() is null (${n} players, step ${steps}) — the game is stuck`)
          break
        }
        const p = active[Math.floor(random() * active.length)]
        let action, r
        try {
          action = g.botAction(clone(state), p, random)
        } catch (err) {
          fail(`botAction(state, ${p}) threw (${n} players, step ${steps})`, err)
          break
        }
        try {
          r = g.applyAction(clone(state), action, {player: p, random})
        } catch (err) {
          fail(`applyAction() threw on the bot's action ${JSON.stringify(action)} (${n} players, step ${steps})`, err)
          break
        }
        if (!r || r.error || !r.state) {
          fail(`The bot for seat ${p} chose an illegal action ${JSON.stringify(action)} → ${r?.error || 'no state returned'} (${n} players, step ${steps}). State excerpt: ${JSON.stringify(state).slice(0, 600)}`)
          break
        }
        if (!serialisable(r.state, `state after ${JSON.stringify(action)}`)) break
        state = r.state
      }
      stats.steps += steps
      try {
        const res = g.result(state)
        if (res) {
          stats.gamesFinished++
          if (!Array.isArray(res.winners)) fail(`result() must return { winners: [...] }, got ${JSON.stringify(res)}`)
        }
      } catch {}
    }
  }

  if (bots && stats.gamesPlayed > 0 && stats.gamesFinished === 0 && problems.length === 0) {
    fail(`No bot game finished within ${MAX_STEPS} moves. Either the end condition is never reached or the bots stall.`)
  }
  out()
}

run().catch(err => {
  fail('Simulator crashed', err)
  out()
})
