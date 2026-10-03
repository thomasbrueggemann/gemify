// Generation through Claude Code (Claude Agent SDK) instead of the Messages
// API. This is how a Claude Code login or a `claude setup-token` token
// (CLAUDE_CODE_OAUTH_TOKEN) can power Gemify: those credentials work with
// Claude Code, not with direct API calls.
//
// The agent works inside the game's own directory: it reads the photos with
// its Read tool, writes game.js and summary.md, and runs lib/check.mjs on its
// own output until the rules check passes. Its permissions are deny-by-default:
// it may read, write and edit files and run exactly that one check command.

import {query} from '@anthropic-ai/claude-agent-sdk'
import {readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {agentTask, agentRepairTask} from './prompt.js'
import {verifyModule} from './verify.js'

const CHECK = fileURLToPath(new URL('./check.mjs', import.meta.url))
const CHECK_COMMAND = `node ${CHECK} game.js`
const MAX_TURNS = 80

/** Environment for the Claude Code process: the token wins over any API key. */
const agentEnv = () => {
  const env = {...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'gemify/0.1.0'}
  // A Claude Code token put into ANTHROPIC_API_KEY by mistake still works.
  if (env.ANTHROPIC_API_KEY?.startsWith('sk-ant-oat')) {
    env.CLAUDE_CODE_OAUTH_TOKEN ??= env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_API_KEY
  }
  return env
}

const describeTool = (block, photos) => {
  const input = block.input || {}
  const file = path.basename(String(input.file_path || ''))
  if (block.name === 'Read' && photos.some(p => p.file === file)) {
    const i = photos.findIndex(p => p.file === file)
    return photos[i].kind === 'rules' ? `Reading rulebook page ${photos.filter(p => p.kind === 'rules').findIndex(p => p.file === file) + 1}…` : 'Looking at the components…'
  }
  if (block.name === 'Write' && file === 'game.js') return 'Writing the game…'
  if (block.name === 'Write' && file === 'summary.md') return 'Writing the rules summary…'
  if (block.name === 'Edit') return `Improving ${file || 'the game'}…`
  if (block.name === 'Bash') return 'Testing the rules with bot players…'
  return null
}

/** Pulls the check output out of a tool result and reports it as a verify event. */
const reportCheck = (block, emit) => {
  const text = Array.isArray(block.content) ? block.content.map(c => c.text || '').join('') : String(block.content || '')
  if (/ALL CHECKS PASSED/.test(text)) {
    const games = text.match(/(\d+)\/\d+ bot games finished/)
    emit({type: 'verify', ok: true, problems: [], stats: {gamesFinished: Number(games?.[1] || 0)}})
  } else if (/PROBLEM\(S\) FOUND/.test(text)) {
    const problems = text.split(/\n\n\d+\. /).slice(1)
    emit({type: 'verify', ok: false, problems: problems.length ? problems : [text.slice(0, 400)]})
  }
}

const run = async ({dir, prompt, photos, emit}) => {
  const model = process.env.GEMIFY_MODEL || 'claude-opus-5-5'
  emit({type: 'stage', text: 'Starting Claude Code…'})
  const checkIds = new Set()
  let lastResult = null

  const session = query({
    prompt,
    options: {
      cwd: dir,
      env: agentEnv(),
      model,
      effort: process.env.GEMIFY_EFFORT || 'high',
      maxTurns: MAX_TURNS,
      tools: ['Read', 'Write', 'Edit', 'Bash'],
      allowedTools: ['Read', 'Write', 'Edit', `Bash(${CHECK_COMMAND})`],
      permissionMode: 'dontAsk',      // anything not allowed above is denied
      settingSources: [],             // ignore the user's/project's Claude Code settings
      persistSession: false,
      stderr: line => process.env.GEMIFY_DEBUG && process.stderr.write(line)
    }
  })

  for await (const msg of session) {
    if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text.trim()) emit({type: 'thinking', text: `${block.text.trim()}\n`})
        if (block.type === 'tool_use') {
          const stage = describeTool(block, photos)
          if (stage) emit({type: 'stage', text: stage})
          if (block.name === 'Bash') checkIds.add(block.id)
        }
      }
    }
    if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) {
        if (block.type === 'tool_result' && checkIds.has(block.tool_use_id)) reportCheck(block, emit)
      }
    }
    if (msg.type === 'result') lastResult = msg
  }

  if (!lastResult) throw new Error('Claude Code stopped without a result.')
  if (lastResult.subtype !== 'success') {
    const why = {
      error_max_turns: 'Claude Code ran out of turns before the game passed its checks.',
      error_max_budget_usd: 'Claude Code hit its budget limit.'
    }[lastResult.subtype]
    throw new Error(why || `Claude Code failed (${lastResult.subtype}).`)
  }
  if (lastResult.is_error) throw new Error(String(lastResult.result || 'Claude Code reported an error.').slice(0, 500))
  emit({type: 'usage', usage: lastResult.usage, costUsd: lastResult.total_cost_usd, models: Object.keys(lastResult.modelUsage || {})})

  // Whatever the agent claims, the server runs the check itself.
  let code
  try {
    code = await readFile(path.join(dir, 'game.js'), 'utf8')
  } catch {
    throw new Error('Claude Code finished without writing game.js.')
  }
  const summaryFile = await readFile(path.join(dir, 'summary.md'), 'utf8').catch(() => '')
  const [first, ...rest] = summaryFile.split('\n')
  const title = first.replace(/^#\s*/, '').trim() || 'Untitled game'
  emit({type: 'stage', text: 'Double-checking the rules…'})
  const report = await verifyModule(code)
  return {title, summary: rest.join('\n').trim(), code, report}
}

/**
 * @param {object} p
 * @param {string} p.dir        the game directory; photos live in dir/photos
 * @param {{kind: string, file: string}[]} p.photos
 */
export const generateWithClaudeCode = async ({dir, photos, notes, emit}) => {
  const files = photos.map(p => ({kind: p.kind, file: `photos/${p.file}`}))
  return run({
    dir,
    prompt: agentTask({photos: files, notes, checkCommand: CHECK_COMMAND}),
    photos: files.map(f => ({...f, file: path.basename(f.file)})),
    emit
  })
}

export const repairWithClaudeCode = async ({dir, game, error, context, emit}) => {
  // The agent edits game.js in place; the server versions the result.
  await writeFile(path.join(dir, 'summary.md'), `# ${game.title}\n\n${game.summary || ''}\n`)
  return run({
    dir,
    prompt: agentRepairTask({error, context, checkCommand: CHECK_COMMAND}),
    photos: [],
    emit
  })
}
