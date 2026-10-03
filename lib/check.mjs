#!/usr/bin/env node
// `node lib/check.mjs game.js` — the rules check as a command, for the
// Claude Code backend (and for you, when hand-editing a game).

import {readFile} from 'node:fs/promises'
import {verifyModule, formatReport} from './verify.js'

const file = process.argv[2]
if (!file) {
  console.error('usage: node lib/check.mjs <game.js>')
  process.exit(2)
}

const report = await verifyModule(await readFile(file, 'utf8'))
const s = report.stats || {}
if (report.ok) {
  console.log(`ALL CHECKS PASSED — player counts ${s.playerCounts?.join(', ')}; ${s.gamesFinished}/${s.gamesPlayed} bot games finished in ${s.steps} moves.`)
} else {
  console.log(`${report.problems.length} PROBLEM(S) FOUND:\n\n${formatReport(report)}`)
  process.exit(1)
}
