// Gemify server: static files, the game store and the Claude pipeline.
//
// Multiplayer and the phone → browser photo transfer do not go through here;
// they are peer-to-peer (Trystero/WebRTC, see public/js/net.js). The server
// exists because the Claude API key must never reach a browser.

import http from 'node:http'
import https from 'node:https'
import {randomBytes} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {existsSync, readFileSync, writeFileSync, mkdirSync} from 'node:fs'
import {readFile, writeFile, mkdir, readdir, copyFile, constants as fsConstants} from 'node:fs/promises'
import {networkInterfaces} from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {generateGame, repairGame, MODEL, BACKEND} from './lib/generate.js'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(ROOT, 'public')
const GAMES = path.resolve(process.env.GEMIFY_GAMES_DIR || path.join(ROOT, 'games'))
const CERTS = path.join(ROOT, '.cert')
const PORT = Number(process.env.PORT || 3000)
const HTTPS_PORT = Number(process.env.HTTPS_PORT || PORT + 443)
const MAX_BODY = 60 * 1024 * 1024
const MAX_PHOTOS = 40

const DEMO = {
  id: 'demo-connect-four',
  title: 'Connect Four (demo)',
  summary: 'Hand-written demo that follows the same contract as generated games. Drop discs into the frame; the first to line up four in a row, column or diagonal wins.',
  status: 'ready',
  version: 1,
  demo: true,
  photos: []
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
}

// ── Helpers ───────────────────────────────────────────────────────────

const lanAddress = () => {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address
  }
  return null
}

const send = (res, status, body, headers = {}) => {
  const isBuf = Buffer.isBuffer(body) || typeof body === 'string'
  res.writeHead(status, {
    'content-type': isBuf ? 'text/plain; charset=utf-8' : 'application/json',
    ...headers
  })
  res.end(isBuf ? body : JSON.stringify(body))
}

const readJson = req => new Promise((resolve, reject) => {
  let size = 0
  const chunks = []
  req.on('data', c => {
    size += c.length
    if (size > MAX_BODY) {
      reject(Object.assign(new Error('Upload too large'), {status: 413}))
      req.destroy()
    } else chunks.push(c)
  })
  req.on('end', () => {
    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { reject(Object.assign(new Error('Invalid JSON'), {status: 400})) }
  })
  req.on('error', reject)
})

const newId = () => randomBytes(6).toString('base64url').replace(/[-_]/g, 'x')
const validId = id => /^[A-Za-z0-9-]{4,40}$/.test(id)
const gameDir = id => path.join(GAMES, id)

const loadMeta = async id => {
  if (id === DEMO.id) return DEMO
  try { return JSON.parse(await readFile(path.join(gameDir(id), 'meta.json'), 'utf8')) } catch { return null }
}
const saveMeta = (meta) => writeFile(path.join(gameDir(meta.id), 'meta.json'), JSON.stringify(meta, null, 2))

// ── Generation jobs: progress fans out to Server-Sent-Events listeners ──

const jobs = new Map()   // id → {events: [], clients: Set<res>, running: boolean}

const jobFor = id => {
  if (!jobs.has(id)) jobs.set(id, {events: [], clients: new Set(), running: false})
  return jobs.get(id)
}

const emitter = id => event => {
  const job = jobFor(id)
  // Thinking deltas are many and small; keep them out of the replay buffer.
  if (event.type !== 'thinking') job.events.push(event)
  const line = `data: ${JSON.stringify(event)}\n\n`
  for (const res of job.clients) res.write(line)
}

// Keep the current version before anything overwrites it (the Claude Code
// backend edits game.js in place). Never clobbers an existing backup.
const backup = meta => meta.version
  ? copyFile(path.join(gameDir(meta.id), 'game.js'), path.join(gameDir(meta.id), `game.v${meta.version}.js`), fsConstants.COPYFILE_EXCL).catch(() => {})
  : Promise.resolve()

const finish = async (meta, outcome, emit) => {
  const dir = gameDir(meta.id)
  await backup(meta)
  await writeFile(path.join(dir, 'game.js'), outcome.code)
  Object.assign(meta, {
    status: 'ready',
    title: outcome.title,
    summary: outcome.summary,
    version: (meta.version || 0) + 1,
    verify: {ok: outcome.report.ok, problems: outcome.report.problems, stats: outcome.report.stats},
    updatedAt: new Date().toISOString()
  })
  delete meta.error
  await saveMeta(meta)
  emit({type: 'done', game: meta})
}

const runJob = async (meta, work) => {
  const job = jobFor(meta.id)
  job.running = true
  job.events = []
  const emit = emitter(meta.id)
  try {
    const outcome = await work(emit)
    await finish(meta, outcome, emit)
  } catch (err) {
    console.error(`[${meta.id}]`, err)
    meta.status = meta.version ? 'ready' : 'failed'
    meta.error = err.message
    await saveMeta(meta)
    emit({type: 'error', message: err.message, game: meta})
  } finally {
    job.running = false
    for (const res of job.clients) res.end()
    job.clients.clear()
  }
}

// ── API ───────────────────────────────────────────────────────────────

const api = async (req, res, url) => {
  const parts = url.pathname.split('/').filter(Boolean).slice(1)  // drop 'api'

  if (parts[0] === 'config') {
    const lan = lanAddress()
    const httpsOn = !!httpsServer
    return send(res, 200, {
      publicUrl: process.env.PUBLIC_URL || (lan && httpsOn ? `https://${lan}:${HTTPS_PORT}` : null),
      lanUrl: lan ? `http://${lan}:${PORT}` : null,
      model: MODEL,
      backend: BACKEND,
      // Claude Code may be logged in via the keychain, which we cannot see: assume yes.
      credentials: BACKEND === 'claude-code' || !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE || existsSync(path.join(process.env.HOME || '', '.config/anthropic')))
    })
  }

  if (parts[0] !== 'games') return send(res, 404, {error: 'Not found'})

  // GET /api/games
  if (parts.length === 1 && req.method === 'GET') {
    await mkdir(GAMES, {recursive: true})
    const ids = (await readdir(GAMES, {withFileTypes: true})).filter(d => d.isDirectory()).map(d => d.name)
    const metas = (await Promise.all(ids.map(loadMeta))).filter(Boolean)
    metas.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    return send(res, 200, [...metas.map(({notes, ...m}) => m), DEMO])
  }

  // POST /api/games  {photos: [{kind, mediaType, data}], notes}
  if (parts.length === 1 && req.method === 'POST') {
    const body = await readJson(req)
    const photos = Array.isArray(body.photos) ? body.photos.slice(0, MAX_PHOTOS) : []
    const ok = photos.every(p => ['rules', 'components'].includes(p.kind) && /^image\/(jpeg|png|webp)$/.test(p.mediaType) && typeof p.data === 'string')
    if (!ok || !photos.some(p => p.kind === 'rules')) return send(res, 400, {error: 'Need at least one rulebook photo (jpeg/png/webp, base64).'})

    const id = newId()
    const dir = gameDir(id)
    await mkdir(path.join(dir, 'photos'), {recursive: true})
    const stored = []
    for (const [i, p] of photos.entries()) {
      const file = `${String(i).padStart(2, '0')}-${p.kind}.${p.mediaType.split('/')[1].replace('jpeg', 'jpg')}`
      await writeFile(path.join(dir, 'photos', file), Buffer.from(p.data, 'base64'))
      stored.push({kind: p.kind, file})
    }
    const meta = {
      id,
      title: 'New game',
      summary: '',
      status: 'generating',
      version: 0,
      notes: String(body.notes || '').slice(0, 4000),
      photos: stored,
      createdAt: new Date().toISOString()
    }
    await saveMeta(meta)
    runJob(meta, emit => generateGame({photos, notes: meta.notes, emit, dir, stored}))
    return send(res, 202, meta)
  }

  const id = parts[1]
  if (!validId(id)) return send(res, 400, {error: 'Bad id'})
  const meta = await loadMeta(id)
  if (!meta) return send(res, 404, {error: 'No such game'})
  const cors = {'access-control-allow-origin': '*'}   // the game iframe has an opaque origin

  // GET /api/games/:id
  if (parts.length === 2) return send(res, 200, meta, cors)

  // GET /api/games/:id/game.js
  if (parts[2] === 'game.js') {
    const file = meta.demo ? path.join(PUBLIC, 'examples/connect-four.js') : path.join(gameDir(id), 'game.js')
    try {
      return send(res, 200, await readFile(file), {...cors, 'content-type': MIME['.js'], 'cache-control': 'no-store'})
    } catch {
      return send(res, 404, {error: 'Not generated yet'})
    }
  }

  // GET /api/games/:id/photos/:n
  if (parts[2] === 'photos' && parts[3] !== undefined) {
    const photo = meta.photos?.[Number(parts[3])]
    if (!photo) return send(res, 404, {error: 'No such photo'})
    return send(res, 200, await readFile(path.join(gameDir(id), 'photos', photo.file)), {
      ...cors, 'content-type': MIME[path.extname(photo.file)], 'cache-control': 'max-age=86400'
    })
  }

  // GET /api/games/:id/events  (Server-Sent Events)
  if (parts[2] === 'events') {
    res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive'})
    const job = jobs.get(id)
    for (const e of job?.events || []) res.write(`data: ${JSON.stringify(e)}\n\n`)
    if (!job?.running) {
      if (!job) res.write(`data: ${JSON.stringify(meta.status === 'failed' ? {type: 'error', message: meta.error, game: meta} : {type: 'done', game: meta})}\n\n`)
      return res.end()
    }
    job.clients.add(res)
    req.on('close', () => job.clients.delete(res))
    return
  }

  // POST /api/games/:id/retry — run the generation again from the stored photos
  if (parts[2] === 'retry' && req.method === 'POST') {
    if (meta.demo) return send(res, 400, {error: 'The demo is not generated.'})
    if (jobs.get(id)?.running) return send(res, 202, meta)
    const photos = await Promise.all(meta.photos.map(async p => ({
      kind: p.kind,
      mediaType: MIME[path.extname(p.file)],
      data: (await readFile(path.join(gameDir(id), 'photos', p.file))).toString('base64')
    })))
    meta.status = 'generating'
    delete meta.error
    await saveMeta(meta)
    runJob(meta, emit => generateGame({photos, notes: meta.notes, emit, dir: gameDir(id), stored: meta.photos}))
    return send(res, 202, meta)
  }

  // POST /api/games/:id/repair  {error, context, version}
  if (parts[2] === 'repair' && req.method === 'POST') {
    if (meta.demo) return send(res, 400, {error: 'The demo cannot be repaired by Claude.'})
    if (jobs.get(id)?.running) return send(res, 202, meta)
    const body = await readJson(req)
    if (body.version && body.version !== meta.version) return send(res, 409, {error: 'A newer version exists already', game: meta})
    const code = await readFile(path.join(gameDir(id), 'game.js'), 'utf8')
    meta.status = 'repairing'
    await saveMeta(meta)
    await backup(meta)
    runJob(meta, emit => repairGame({
      dir: gameDir(id),
      game: meta,
      code,
      error: String(body.error || 'unknown error').slice(0, 6000),
      context: String(body.context || '').slice(0, 2000),
      emit
    }))
    return send(res, 202, meta)
  }

  send(res, 404, {error: 'Not found'})
}

// ── Static files ──────────────────────────────────────────────────────

const serveStatic = async (req, res, url) => {
  let rel = decodeURIComponent(url.pathname)
  if (rel.endsWith('/')) rel += 'index.html'
  const file = path.normalize(path.join(PUBLIC, rel))
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden')
  try {
    const body = await readFile(file)
    send(res, 200, body, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      // The sandboxed game iframe has an opaque origin, so even /js/frame.js
      // is a cross-origin module load for it.
      'access-control-allow-origin': '*'
    })
  } catch {
    send(res, 404, 'Not found')
  }
}

const handler = async (req, res) => {
  const url = new URL(req.url, 'http://x')
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url)
    else await serveStatic(req, res, url)
  } catch (err) {
    console.error(err)
    if (!res.headersSent) send(res, err.status || 500, {error: err.message})
    else res.end()
  }
}

// ── HTTPS for phones on the LAN ───────────────────────────────────────
// Phones only expose camera APIs and crypto.subtle (needed by Trystero) on
// secure origins. Without PUBLIC_URL we serve a self-signed certificate.

const ensureCert = () => {
  const key = path.join(CERTS, 'key.pem')
  const cert = path.join(CERTS, 'cert.pem')
  const stamp = path.join(CERTS, 'ip.txt')
  const lan = String(lanAddress())
  // Regenerate when the LAN address changes, so the certificate names it.
  if (!existsSync(cert) || !existsSync(stamp) || readFileSync(stamp, 'utf8') !== lan) {
    mkdirSync(CERTS, {recursive: true})
    const san = ['DNS:localhost', 'IP:127.0.0.1', lan !== 'null' && `IP:${lan}`].filter(Boolean).join(',')
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
      '-days', '825', '-subj', '/CN=gemify', '-addext', `subjectAltName=${san}`], {stdio: 'ignore'})
    writeFileSync(stamp, lan)
  }
  return {key: readFileSync(key), cert: readFileSync(cert)}
}

let httpsServer = null

await mkdir(GAMES, {recursive: true})
http.createServer(handler).listen(PORT, () => {
  console.log(`\n  Gemify  →  http://localhost:${PORT}`)
})

if (!process.env.PUBLIC_URL && process.env.HTTPS !== '0') {
  try {
    httpsServer = https.createServer(ensureCert(), handler).listen(HTTPS_PORT, () => {
      const lan = lanAddress()
      if (lan) console.log(`  Phones   →  https://${lan}:${HTTPS_PORT}  (self-signed: accept the warning once)`)
    })
  } catch (err) {
    console.warn(`  HTTPS disabled (${err.message}). Set PUBLIC_URL to an https tunnel so phones can connect.`)
  }
} else if (process.env.PUBLIC_URL) {
  console.log(`  Public   →  ${process.env.PUBLIC_URL}`)
}
console.log(`  Claude   →  ${BACKEND === 'api' ? `Messages API, ${MODEL}` : `Claude Code (${process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'local login'}), ${MODEL}`}\n`)
