// Turns photos into a game module with Claude, then checks it with the
// headless simulator and feeds failures back until it passes (or we give up).

import Anthropic from '@anthropic-ai/sdk'
import {SYSTEM_PROMPT, firstTurnText, fixTurnText, repairTurnText} from './prompt.js'
import {verifyModule, formatReport} from './verify.js'
import {generateWithClaudeCode, repairWithClaudeCode} from './claude-code.js'

// 'api'          Messages API with ANTHROPIC_API_KEY (one streamed answer + fix rounds)
// 'claude-code'  Claude Code via the Agent SDK, with CLAUDE_CODE_OAUTH_TOKEN
//                (`claude setup-token`) or this machine's Claude Code login
const chooseBackend = () => {
  if (process.env.GEMIFY_BACKEND) return process.env.GEMIFY_BACKEND
  const key = process.env.ANTHROPIC_API_KEY
  return key && !key.startsWith('sk-ant-oat') ? 'api' : 'claude-code'
}
export const BACKEND = chooseBackend()

// Same model on both backends.
export const MODEL = process.env.GEMIFY_MODEL || 'claude-opus-5-5'
const EFFORT = process.env.GEMIFY_EFFORT || 'high'
const MAX_FIX_ROUNDS = 2

let client = null
const anthropic = () => (client ??= new Anthropic())

/** Splits Claude's three-part answer into title, summary and code. */
export const parseAnswer = text => {
  const title = text.match(/<game_title>([\s\S]*?)<\/game_title>/)?.[1].trim()
  const summary = text.match(/<rules_summary>([\s\S]*?)<\/rules_summary>/)?.[1].trim()
  const blocks = [...text.matchAll(/```(?:javascript|js|mjs)?\s*\n([\s\S]*?)```/g)]
  const code = blocks.length ? blocks.sort((a, b) => b[1].length - a[1].length)[0][1].trim() : null
  if (!code) throw new Error('Claude did not return a code block')
  return {title: title || 'Untitled game', summary: summary || '', code}
}

const friendly = err => {
  if (err instanceof Anthropic.AuthenticationError || /authentication method|api[_ -]?key/i.test(err.message)) {
    return new Error('The server has no valid Anthropic credentials. Set ANTHROPIC_API_KEY (or run `ant auth login`) and restart the server.')
  }
  if (err instanceof Anthropic.RateLimitError) return new Error('Claude is rate-limited right now. Wait a minute and try again.')
  if (err instanceof Anthropic.APIConnectionError) return new Error('Could not reach the Claude API. Check the server\'s internet connection.')
  if (err instanceof Anthropic.APIError && err.status >= 500) return new Error(`The Claude API had a hiccup (${err.status}: ${err.message}). Try again in a moment.`)
  return err
}

const textOf = message =>
  message.content.filter(b => b.type === 'text').map(b => b.text).join('')

/**
 * One streamed request. Forwards thinking summaries and output progress via
 * emit(), returns the final message.
 */
const ask = async (messages, emit) => {
  try {
    return await askOnce(messages, emit)
  } catch (err) {
    throw friendly(err)
  }
}

const askOnce = async (messages, emit) => {
  const stream = anthropic().beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: {type: 'adaptive', display: 'summarized'},
    output_config: {effort: EFFORT},
    cache_control: {type: 'ephemeral'},
    system: SYSTEM_PROMPT,
    messages
  })

  let chars = 0
  let lastTick = 0
  for await (const event of stream) {
    if (event.type === 'content_block_start' && event.content_block.type === 'thinking') {
      emit({type: 'stage', text: 'Claude is studying the rules…'})
    } else if (event.type === 'content_block_start' && event.content_block.type === 'text') {
      emit({type: 'stage', text: 'Claude is writing the game…'})
    } else if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta') {
      emit({type: 'thinking', text: event.delta.thinking})
    } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      chars += event.delta.text.length
      if (chars - lastTick > 400) {
        lastTick = chars
        emit({type: 'progress', chars})
      }
    }
  }

  const message = await stream.finalMessage()
  if (message.stop_reason === 'refusal') {
    throw new Error(`Claude declined this request${message.stop_details?.explanation ? `: ${message.stop_details.explanation}` : '.'}`)
  }
  if (message.stop_reason === 'max_tokens') {
    throw new Error('The game was too large to finish in one answer. Try fewer or clearer photos.')
  }
  emit({type: 'usage', usage: message.usage, model: message.model})
  return message
}

/**
 * Asks, parses, verifies; on failure appends the report to the same
 * conversation (append-only, so thinking blocks stay valid) and asks again.
 */
const askUntilValid = async (messages, emit) => {
  let best = null
  for (let round = 0; round <= MAX_FIX_ROUNDS; round++) {
    const message = await ask(messages, emit)
    messages.push({role: 'assistant', content: message.content})

    let parsed
    try {
      parsed = parseAnswer(textOf(message))
    } catch (err) {
      if (round === MAX_FIX_ROUNDS) throw err
      emit({type: 'stage', text: 'The answer was malformed, asking again…'})
      messages.push({role: 'user', content: `${err.message}. Answer again in the exact three-part format.`})
      continue
    }

    emit({type: 'stage', text: 'Testing the rules with bot players…'})
    const report = await verifyModule(parsed.code)
    best = {...parsed, report}
    emit({type: 'verify', ok: report.ok, problems: report.problems, stats: report.stats})
    if (report.ok) return best
    if (round === MAX_FIX_ROUNDS) break

    emit({type: 'stage', text: `Found ${report.problems.length} problem(s), Claude is fixing them (round ${round + 1}/${MAX_FIX_ROUNDS})…`})
    messages.push({role: 'user', content: fixTurnText(formatReport(report))})
  }
  // Hand back the last attempt anyway: the browser can still try it and the
  // players can ask for a repair with the concrete error.
  return best
}

/**
 * @param {object} p
 * @param {{kind: 'rules'|'components', mediaType: string, data: string}[]} p.photos  base64 data
 * @param {string} p.notes
 * @param {(event: object) => void} p.emit
 */
export const generateGame = async ({photos, notes, emit, dir, stored}) => {
  if (BACKEND === 'claude-code') return generateWithClaudeCode({dir, photos: stored, notes, emit})
  const counts = {rules: 0, components: 0}
  const content = []
  for (const kind of ['rules', 'components']) {
    const group = photos.filter(p => p.kind === kind)
    counts[kind] = group.length
    if (!group.length) continue
    content.push({type: 'text', text: kind === 'rules' ? '## Rulebook photos' : '## Component photos'})
    group.forEach((p, i) => {
      content.push({type: 'text', text: `${kind === 'rules' ? 'Page' : 'Photo'} ${i + 1}:`})
      content.push({type: 'image', source: {type: 'base64', media_type: p.mediaType, data: p.data}})
    })
  }
  content.push({type: 'text', text: firstTurnText({notes, counts})})

  emit({type: 'stage', text: `Sending ${photos.length} photos to Claude…`})
  return askUntilValid([{role: 'user', content}], emit)
}

/** Fixes a game that crashed in the browser. */
export const repairGame = async ({game, code, error, context, emit, dir}) => {
  if (BACKEND === 'claude-code') return repairWithClaudeCode({dir, game, error, context, emit})
  emit({type: 'stage', text: 'Sending the crash report to Claude…'})
  const messages = [{
    role: 'user',
    content: repairTurnText({title: game.title, summary: game.summary, code, error, context})
  }]
  return askUntilValid(messages, emit)
}
