#!/usr/bin/env node
// Regenerates the README screenshots in docs/screenshots/ by driving the real
// app with Playwright: a desktop host, a phone that sends photos over WebRTC,
// and a second player who joins online.
//
//   npm run screenshots
//
// Uses a throwaway games directory, so your own games never show up. The
// build screen replays a scripted event stream (a real generation takes
// minutes and needs credentials); everything else is live.

import {chromium, devices} from 'playwright'
import {spawn} from 'node:child_process'
import {mkdtemp, mkdir, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'docs/screenshots')
const PORT = 3900 + Math.floor(Math.random() * 90)
const BASE = `http://localhost:${PORT}`
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── Server ────────────────────────────────────────────────────────────

const startServer = async gamesDir => {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      GEMIFY_GAMES_DIR: gamesDir,
      // What a phone on the LAN would see in the QR code.
      PUBLIC_URL: 'https://192.168.1.20:3443'
    },
    stdio: 'ignore'
  })
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/api/config`)).ok) return server
    } catch {}
    await sleep(200)
  }
  server.kill()
  throw new Error('Server did not start')
}

// ── Sample "photos" of a Connect Four box, rendered as images ─────────

const paper = (title, body, tilt) => `
<body style="margin:0;width:900px;height:1200px;display:grid;place-items:center;background:radial-gradient(circle at 30% 20%,#8a6a4a,#4a3423)">
  <div style="width:720px;height:1000px;background:#fbf6ea;transform:rotate(${tilt}deg);box-shadow:0 30px 60px rgba(0,0,0,.5);padding:64px 70px;box-sizing:border-box;font-family:Georgia,serif;color:#2a2a2a">
    <div style="font:800 46px Arial Black,Arial;color:#1d47a8;letter-spacing:1px">${title}</div>
    <div style="height:6px;background:linear-gradient(90deg,#e4572e,#f3c623);margin:14px 0 30px"></div>
    <div style="font-size:23px;line-height:1.55">${body}</div>
  </div>
</body>`

const RULES = [
  paper('CONNECT FOUR', `<b>OBJECT OF THE GAME</b><br>Be the first player to get four of your coloured discs in a row — horizontally, vertically or diagonally.<br><br><b>CONTENTS</b><br>1 grid with 7 columns and 6 rows · 21 red discs · 21 yellow discs · 2 legs<br><br><b>SET UP</b><br>Attach the legs to the grid and stand it upright between the players. Each player takes all discs of one colour.`, -1.5),
  paper('HOW TO PLAY', `Decide who goes first. Players take turns.<br><br>On your turn, drop <b>one</b> of your discs into any column that is not full. The disc falls to the lowest empty space.<br><br>You must drop a disc on your turn; you cannot pass.<br><br><b>WINNING</b><br>The first player to line up four discs wins. If the grid fills up with no line of four, the game is a draw.`, 1.2)
]

const BOARD = `
<body style="margin:0;width:1200px;height:900px;display:grid;place-items:center;background:radial-gradient(circle at 60% 30%,#9b7653,#4a3423)">
  <div style="transform:rotate(-3deg) perspective(900px) rotateX(12deg);background:#2456c9;padding:26px;border-radius:18px;box-shadow:0 40px 70px rgba(0,0,0,.55);display:grid;grid-template-columns:repeat(7,82px);gap:14px">
    ${Array.from({length: 42}, (_, i) => {
      const filled = {38: '#e4572e', 39: '#f3c623', 31: '#e4572e', 40: '#e4572e', 32: '#f3c623', 37: '#f3c623'}[i]
      return `<div style="width:82px;height:82px;border-radius:50%;background:${filled || '#5a4330'};box-shadow:inset 0 6px 10px rgba(0,0,0,.35)"></div>`
    }).join('')}
  </div>
</body>`

const DISCS = `
<body style="margin:0;width:1200px;height:900px;background:radial-gradient(circle at 40% 40%,#9b7653,#4a3423);position:relative;overflow:hidden">
  ${Array.from({length: 22}, (_, i) => {
    const x = 120 + (i % 7) * 140 + (i % 3) * 18, y = 140 + Math.floor(i / 7) * 170 + (i % 2) * 30
    return `<div style="position:absolute;left:${x}px;top:${y}px;width:120px;height:120px;border-radius:50%;background:${i % 2 ? '#f3c623' : '#e4572e'};box-shadow:0 10px 18px rgba(0,0,0,.45),inset 0 -8px 0 rgba(0,0,0,.18),inset 0 0 0 14px rgba(255,255,255,.12)"></div>`
  }).join('')}
</body>`

const renderPhoto = async (browser, html, name) => {
  const page = await browser.newPage({viewport: {width: 900, height: 900}})
  await page.setContent(html)
  const size = await page.evaluate(() => ({width: document.body.scrollWidth, height: document.body.scrollHeight}))
  await page.setViewportSize(size)
  const buffer = await page.screenshot({type: 'jpeg', quality: 88})
  await page.close()
  return {name, mimeType: 'image/jpeg', buffer}
}

// ── Scripted build progress (shape of the real SSE events) ────────────

const BUILD_EVENTS = [
  {type: 'stage', text: 'Claude is studying the rules…'},
  {type: 'thinking', text: 'Two rulebook pages and two component photos. The grid is 7 columns × 6 rows, 21 discs per colour, so 42 moves at most. '},
  {type: 'thinking', text: 'Discs fall to the lowest empty cell; a full column is an illegal move. Win check needs horizontal, vertical and both diagonals through the last disc. '},
  {type: 'thinking', text: 'No hidden information, so playerView can return the state. For the bot: win if possible, block an immediate loss, otherwise prefer central columns. '},
  {type: 'stage', text: 'Claude is writing the game…'},
  {type: 'progress', chars: 21400},
  {type: 'stage', text: 'Testing the rules with bot players…'},
  {type: 'verify', ok: false, problems: ['The bot for seat 1 chose an illegal action {"type":"drop","col":7} → No such column (2 players, step 11)']},
  {type: 'stage', text: 'Found 1 problem(s), Claude is fixing them (round 1/2)…'},
  {type: 'thinking', text: 'The bot iterates columns 0..7 inclusive — off by one. Restrict it to the legal columns list. '},
  {type: 'progress', chars: 34800},
  {type: 'verify', ok: true, problems: [], stats: {gamesFinished: 3}},
  {type: 'stage', text: 'Double-checking the rules…'}
]

const fakeBuild = async page => {
  await page.route('**/api/games', route => route.request().method() === 'POST'
    ? route.fulfill({status: 202, json: {id: 'screenshot-build', status: 'generating'}})
    : route.fallback())
  await page.route('**/api/games/screenshot-build/events', route => route.fulfill({
    status: 200,
    headers: {'content-type': 'text/event-stream'},
    body: BUILD_EVENTS.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')
  }))
}

// ── Helpers ───────────────────────────────────────────────────────────

const ready = async page => {
  await page.evaluate(() => document.fonts.ready)
  await sleep(300)
}

const shot = async (page, name, opts = {}) => {
  await ready(page)
  const file = path.join(OUT, name)
  await page.screenshot({path: file, ...opts})
  console.log('  ✓', path.relative(ROOT, file))
}

// ── Run ───────────────────────────────────────────────────────────────

const main = async () => {
  await mkdir(OUT, {recursive: true})
  const gamesDir = await mkdtemp(path.join(tmpdir(), 'gemify-shots-'))
  const server = await startServer(gamesDir)
  const browser = await chromium.launch({args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']})

  try {
    const desktop = {viewport: {width: 1280, height: 800}, deviceScaleFactor: 2, colorScheme: 'dark'}
    const phoneDevice = {...devices['iPhone 13'], deviceScaleFactor: 3}
    delete phoneDevice.defaultBrowserType

    console.log('Rendering sample photos…')
    const rules = [await renderPhoto(browser, RULES[0], 'rules-1.jpg'), await renderPhoto(browser, RULES[1], 'rules-2.jpg')]
    const parts = [await renderPhoto(browser, BOARD, 'board.jpg'), await renderPhoto(browser, DISCS, 'discs.jpg')]

    console.log('Capturing…')
    const hostCtx = await browser.newContext(desktop)
    await hostCtx.addInitScript(() => localStorage.setItem('gemify:name', 'Thomas'))
    const host = await hostCtx.newPage()
    await host.goto(BASE)
    await host.waitForSelector('.game-card')
    await shot(host, '01-home.png')

    // Host starts a scan; the phone joins with the room code from the QR link.
    await host.click('#btn-new')
    await host.waitForFunction(() => document.querySelector('#room-code').textContent.length === 6)
    const code = await host.textContent('#room-code')

    const phoneCtx = await browser.newContext(phoneDevice)
    const phone = await phoneCtx.newPage()
    await phone.goto(`${BASE}/scan.html?room=${code}`)
    await phone.waitForSelector('#s-rules:not([hidden])', {timeout: 60000})
    await phone.setInputFiles('#s-rules input[multiple]', rules)
    await phone.waitForFunction(() => document.querySelectorAll('#list-rules .thumb.sent').length === 2, null, {timeout: 60000})
    await shot(phone, '02-phone-rulebook.png')

    await phone.click('#to-components')
    await phone.setInputFiles('#s-components input[multiple]', parts)
    await phone.waitForFunction(() => document.querySelectorAll('#list-components .thumb.sent').length === 2, null, {timeout: 60000})
    await phone.fill('#notes', 'We always let the youngest player start.')
    await phone.locator('#notes').blur()
    await shot(phone, '03-phone-components.png')

    await host.waitForFunction(() => document.querySelectorAll('#thumbs-rules .thumb, #thumbs-components .thumb').length === 4)
    await sleep(500)
    await shot(host, '04-photos-arrived.png')

    // Build screen, driven by the scripted events.
    await fakeBuild(host)
    await phone.click('#send')
    await host.waitForSelector('#build-checks li.ok')
    await sleep(1200)  // let the progress bar finish its transition
    await shot(host, '05-building.png')
    await phone.waitForSelector('#s-status:not([hidden])')
    await shot(phone, '06-phone-building.png')
    await phoneCtx.close()
    await host.unrouteAll()

    // Lobby with a friend joining online.
    await host.goto(`${BASE}/?game=demo-connect-four`)
    await host.waitForSelector('#seats li')
    const room = await host.textContent('.room-code-copy')
    const guestCtx = await browser.newContext(desktop)
    await guestCtx.addInitScript(() => localStorage.setItem('gemify:name', 'Sam'))
    const guest = await guestCtx.newPage()
    await guest.goto(`${BASE}/?join=${room}`)
    await host.waitForFunction(() => [...document.querySelectorAll('#seats .seat-name')].some(s => s.textContent.includes('Sam')), null, {timeout: 60000})
    await shot(host, '07-lobby.png')

    // Play a few moves: host and guest alternate on the middle columns.
    await host.click('#btn-start')
    await guest.waitForFunction(() => document.body.dataset.view === 'play', null, {timeout: 30000})
    await sleep(4000)  // three.js from the CDN, first frames
    const column = c => ({x: 640 + (c - 3) * 74, y: 470})
    const moves = [[host, 3], [guest, 3], [host, 2], [guest, 4], [host, 4], [guest, 2], [host, 5]]
    for (const [page, c] of moves) {
      await page.mouse.click(column(c).x, column(c).y)
      await sleep(2200)
    }
    await sleep(3500)  // software WebGL is slow: let the last disc land
    await shot(host, '08-playing.png')
    await shot(guest, '09-playing-guest.png')
  } finally {
    await browser.close()
    server.kill()
    await rm(gamesDir, {recursive: true, force: true})
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
