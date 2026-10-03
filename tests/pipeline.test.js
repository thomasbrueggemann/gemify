// node --test tests/
// No network, no API key: covers answer parsing and the headless rules check
// that gates every generated game.

import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {parseAnswer} from '../lib/generate.js'
import {verifyModule} from '../lib/verify.js'
import {renderMarkdown} from '../public/js/markdown.js'

const demo = await readFile(new URL('../public/examples/connect-four.js', import.meta.url), 'utf8')

const stub = (overrides = '') => `
export const meta = {title: 'Stub', minPlayers: 2, maxPlayers: 3, supportsBots: true}
export function setup({numPlayers}) { return {n: numPlayers, turn: 0, left: 5} }
export function activePlayers(s) { return s.left > 0 ? [s.turn] : [] }
export function applyAction(s, a, {player}) {
  if (a?.type !== 'take') return {error: 'Unknown action'}
  if (player !== s.turn) return {error: 'Not your turn'}
  s.left--; s.turn = (s.turn + 1) % s.n
  return {state: s}
}
export function result(s) { return s.left > 0 ? null : {winners: [0], message: 'done'} }
export function playerView(s) { return s }
export function botAction() { return {type: 'take'} }
export function createRenderer() { return {update() {}, dispose() {}} }
${overrides}`

test('parseAnswer extracts title, summary and the module', () => {
  const out = parseAnswer(`<game_title>Ludo</game_title>
<rules_summary>
Roll and race.
</rules_summary>
\`\`\`javascript
export const meta = {}
\`\`\``)
  assert.equal(out.title, 'Ludo')
  assert.equal(out.summary, 'Roll and race.')
  assert.equal(out.code, 'export const meta = {}')
})

test('parseAnswer picks the largest code block', () => {
  const out = parseAnswer('```js\nsmall\n```\n```javascript\nthe real module, much longer\n```')
  assert.equal(out.code, 'the real module, much longer')
})

test('parseAnswer fails without code', () => {
  assert.throws(() => parseAnswer('<game_title>X</game_title>'), /code block/)
})

test('the demo game passes the rules check', async () => {
  const r = await verifyModule(demo)
  assert.deepEqual(r.problems, [])
  assert.ok(r.stats.gamesFinished >= 3)
})

test('a well-formed stub passes', async () => {
  const r = await verifyModule(stub())
  assert.equal(r.ok, true, r.problems.join('\n'))
})

test('non-JSON state is reported', async () => {
  const r = await verifyModule(stub().replace('return {n: numPlayers, turn: 0, left: 5}', 'return {n: numPlayers, turn: 0, left: 5, seen: new Set()}'))
  assert.equal(r.ok, false)
  assert.match(r.problems.join('\n'), /\$\.seen is a Set/)
})

test('illegal bot moves are reported with the action', async () => {
  const r = await verifyModule(stub().replace("export function botAction() { return {type: 'take'} }", "export function botAction() { return {type: 'pass'} }"))
  assert.equal(r.ok, false)
  assert.match(r.problems[0], /illegal action \{"type":"pass"\}/)
})

test('a game that never ends is reported', async () => {
  const r = await verifyModule(stub().replace('s.left--;', ''))
  assert.equal(r.ok, false)
  assert.match(r.problems.join('\n'), /No bot game finished/)
})

test('throwing on unknown actions is reported', async () => {
  const r = await verifyModule(stub().replace("return {error: 'Unknown action'}", "throw new Error('boom')"))
  assert.match(r.problems.join('\n'), /threw on an unknown action/)
})

test('generated code cannot write files or spawn processes', async () => {
  const r = await verifyModule(`import fs from 'node:fs'; fs.writeFileSync('/tmp/gemify-should-not-exist', 'x');` + stub())
  assert.equal(r.ok, false)
  assert.match(r.problems[0], /allow-fs-write|ERR_ACCESS_DENIED|restricted/i)
})

test('infinite loops are killed', {timeout: 60_000}, async () => {
  const r = await verifyModule(stub().replace('return {n: numPlayers, turn: 0, left: 5}', 'while (true) {}'))
  assert.equal(r.ok, false)
  assert.match(r.problems[0], /did not finish/)
})

test('markdown escapes HTML', () => {
  const html = renderMarkdown('## Goal\n- **Win** by <script>alert(1)</script>\n\nText')
  assert.match(html, /<h4>Goal<\/h4>/)
  assert.match(html, /<li><strong>Win<\/strong> by &lt;script&gt;/)
  assert.doesNotMatch(html, /<script>/)
})
