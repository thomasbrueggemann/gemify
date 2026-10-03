// Runs a generated module through lib/simulate.mjs in a locked-down child
// process: Node's permission model allows reading only the module and the
// simulator (no fs writes, no child processes, no workers), with a hard timeout.

import {spawn} from 'node:child_process'
import {mkdtemp, writeFile, rm, realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const SIMULATOR = fileURLToPath(new URL('./simulate.mjs', import.meta.url))
const TIMEOUT_MS = 30_000

export const verifyModule = async code => {
  // realpath: on macOS the tmp dir is a symlink and the permission model checks real paths.
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'gemify-')))
  const file = path.join(dir, 'game.mjs')
  await writeFile(file, code)

  try {
    return await new Promise(resolve => {
      const child = spawn(process.execPath, [
        '--permission',
        `--allow-fs-read=${file}`,
        `--allow-fs-read=${SIMULATOR}`,
        '--max-old-space-size=256',
        SIMULATOR,
        file
      ], {stdio: ['ignore', 'pipe', 'pipe']})

      let stdout = ''
      let stderr = ''
      child.stdout.on('data', d => { stdout += d })
      child.stderr.on('data', d => { stderr += d })

      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve({ok: false, problems: [`The rules did not finish within ${TIMEOUT_MS / 1000}s — probably an infinite loop in setup(), applyAction() or botAction().`]})
      }, TIMEOUT_MS)

      child.on('close', () => {
        clearTimeout(timer)
        const line = stdout.trim().split('\n').pop()
        try {
          resolve(JSON.parse(line))
        } catch {
          resolve({ok: false, problems: [`The module crashed the simulator:\n${(stderr || stdout).slice(0, 2000)}`]})
        }
      })
    })
  } finally {
    rm(dir, {recursive: true, force: true}).catch(() => {})
  }
}

export const formatReport = report =>
  report.problems.map((p, i) => `${i + 1}. ${p}`).join('\n\n')
