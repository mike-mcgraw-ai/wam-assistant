#!/usr/bin/env node
/**
 * Desktop agent runner — runs on your Mac, not on the hub.
 *
 * Polls the hub for work, claims it, does the thinking locally, posts the
 * result back. The thinking is shelled out to whatever you already pay for
 * (Claude Code by default) rather than a metered API, which is the whole point
 * of the split: the hub is dumb storage and the Mac is the brain.
 *
 * Cost lives entirely in this file's schedule. The hub queues work the moment
 * something is captured, but nothing happens until this runs — so an hourly
 * cron and a nightly cron cost very different amounts and neither requires a
 * change anywhere else.
 *
 *   node runner.mjs --once          one pass, then exit (use from cron)
 *   node runner.mjs                 stay up, poll every POLL_SECONDS
 *   node runner.mjs --dry           show the prompt, call nothing
 *
 * Env:
 *   HUB_URL       default http://localhost:8787
 *   AGENT_TOKEN   must match the hub
 *   AGENT_NAME    default this machine's hostname
 *   AGENT_CMD     default: claude -p
 *                 Anything that reads a prompt on stdin and prints the answer
 *                 on stdout works — swap in another CLI or a local model.
 *   POLL_SECONDS  default 900 (15 min) in loop mode
 */

import { spawn } from 'node:child_process'
import { hostname } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const HUB = (process.env.HUB_URL || 'http://localhost:8787').replace(/\/+$/, '')
const TOKEN = process.env.AGENT_TOKEN || ''
const NAME = process.env.AGENT_NAME || hostname()
const CMD = process.env.AGENT_CMD || 'claude -p'
const CHATGPT_CMD = process.env.CHATGPT_CMD || `codex exec --ephemeral --sandbox workspace-write -C ${ROOT} -`
const CLAUDE_CMD = process.env.CLAUDE_CMD || 'claude -p'
const POLL_SECONDS = Number(process.env.POLL_SECONDS) || 900

const ONCE = process.argv.includes('--once')
const DRY = process.argv.includes('--dry')
const ONLY_CAPABILITY = process.argv
  .find(arg => arg.startsWith('--capability='))
  ?.slice('--capability='.length)

const headers = { 'Content-Type': 'application/json' }
if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`

const api = async (path, options = {}) => {
  const res = await fetch(`${HUB}${path}`, { ...options, headers })
  if (!res.ok) throw new Error(`${options.method || 'GET'} ${path} -> ${res.status}`)
  return res.json()
}

/**
 * Run the model command with a prompt on stdin.
 * Deliberately not an API client: whatever you can run on this machine and
 * already pay for is a valid brain.
 */
function think(prompt, timeoutMs = 180_000, command = CMD) {
  return new Promise((resolve, reject) => {
    const [bin, ...args] = command.split(/\s+/)
    const child = spawn(bin, args, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] })

    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`timed out after ${timeoutMs / 1000}s`))
    }, timeoutMs)

    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (err += d))
    child.on('error', e => {
      clearTimeout(timer)
      reject(new Error(`could not run "${bin}": ${e.message}`))
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`${bin} exited ${code}: ${err.slice(0, 200)}`))
      resolve(out)
    })

    child.stdin.write(prompt)
    child.stdin.end()
  })
}

/** Pull the first JSON array or object out of a reply that may carry prose. */
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.search(/[[{]/)
  if (start === -1) throw new Error('no JSON in reply')
  // Walk back from the end for the matching close, which survives a trailing
  // "Let me know if..." that some models add.
  const end = Math.max(candidate.lastIndexOf(']'), candidate.lastIndexOf('}'))
  if (end <= start) throw new Error('unbalanced JSON in reply')
  return JSON.parse(candidate.slice(start, end + 1))
}

// ---- capabilities ---------------------------------------------------------

const TRIAGE_PROMPT = `Sort these captured household notes. Return ONLY a JSON array, no prose.

For each line return:
  itemId  the id you were given, exactly
  kind    "shopping" | "task" | "steps" | "reminder" | "note"
  list    short Title Case list name. "Groceries" for food and household
          supplies, "Hardware" for tools and DIY, "Errands" for things done
          away from home, "Home" for jobs around the house.
  parts   array; split "milk and cat food" into two. One item is one element.
  note    optional, max 8 words, only if it adds something the text does not say.

Keep the person's own words in parts. Do not tidy or expand them.
Never invent items that were not said.

Notes:
`

const COACH_CUE_PROMPT = `You are writing a tiny heads-up cue for smart glasses.

Return ONLY a JSON object, no prose:
{
  "title": "30 characters max",
  "lines": ["up to 3 lines, 44 characters max each"],
  "kind": "answer" | "followup" | "factcheck" | "advice" | "thought" | "recap",
  "priority": 0 | 1 | 2 | 3 | 4,
  "quiet": false,
  "runningNote": {
    "thread": "the main thread worth returning to",
    "now": "what the conversation is on right now",
    "hold": "a parked tangent, connection, open question, or next action"
  }
}

Use the mode instructions and the recent transcript. Help only when a cue would
be useful mid-conversation: a short answer, a tactful correction, a good
follow-up, concrete supportive advice, a thought worth holding, or a recap.
Do not invent facts, names, times, durations, or estimates. Do not tell the user
to do anything irreversible without explicit confirmation. If there is no useful
cue, return {"quiet":true,"title":"Listening","lines":[],"kind":"thought","priority":0}.

Always update runningNote, even when the cue is quiet. It is a conversation
compass, not a second transcript:
- thread preserves the durable purpose or main idea from the whole conversation,
  especially across a tangent
- now names the latest meaningful topic in plain language, not merely the last
  words the microphone heard
- hold keeps the single most useful connection, parked tangent, unresolved
  question, promise, or next action
Keep each value concrete and short. Preserve the previous thread until the
transcript clearly resolves or replaces it. Never invent a connection.

The transcript comes from fixed-duration audio chunks and may contain broken
sentences, wrong speaker labels, repeated reactions, child/pet directions,
greetings, and ambient family chatter. Reconstruct thoughts across chunks.
Do not let "wow", "okay", "good job", farewells, or incidental scene narration
replace a durable request, decision, fact, or open loop. If the user deliberately
asks to preserve a memory, that memory is durable; otherwise prioritize explicit
phrases such as "we need to", "I want", "remind me", and "the point is".
`

const ASSISTANT_CHAT_PROMPT = `You are the user's working assistant, reached by
voice from smart glasses. Continue the conversation below and answer the latest
user turn. You are running inside the WAM repository and may inspect or edit it
when the latest turn explicitly asks you to do work. Follow AGENTS.md and the
repository's version-claim rules before editing. Do not ship, install, restart,
delete, purchase, send, or perform another external action unless the user
explicitly asks. Keep the response direct and readable on a tiny display:
plain text, short paragraphs, no tables, and normally under 1,200 characters.

Conversation:
`

function trimText(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function normalizeRunningNote(raw, constraints = {}) {
  if (!raw || typeof raw !== 'object') return null
  const max = Number(constraints.noteLineChars) || 42
  const line = (label, value) => {
    const prefix = `${label}: `
    const body = trimText(value, Math.max(1, max - prefix.length))
    return body ? `${prefix}${body}` : ''
  }
  const lines = Array.isArray(raw.lines)
    ? raw.lines.map(value => trimText(value, max)).filter(Boolean).slice(0, 3)
    : [line('Thread', raw.thread), line('Now', raw.now), line('Hold', raw.hold)].filter(Boolean)

  return lines.length > 0 ? { title: 'Conversation compass', lines } : null
}

function normalizeCoachCue(parsed, constraints = {}) {
  if (!parsed || typeof parsed !== 'object') throw new Error('expected a JSON object')
  const allowed = new Set(Array.isArray(constraints.allowedKinds) ? constraints.allowedKinds : [])
  const fallbackKind = allowed.has('thought') ? 'thought' : [...allowed][0] || 'thought'
  const kind = allowed.has(parsed.kind) ? parsed.kind : fallbackKind
  const runningNote = normalizeRunningNote(parsed.runningNote, constraints)

  if (parsed.quiet === true) {
    return { title: 'Listening', lines: [], kind, priority: 0, quiet: true, runningNote }
  }

  const title = trimText(parsed.title || 'Coach', Number(constraints.titleChars) || 30)
  const rawLines = Array.isArray(parsed.lines) ? parsed.lines : [parsed.body, parsed.text]
  const lines = rawLines
    .map(line => trimText(line, Number(constraints.lineChars) || 44))
    .filter(Boolean)
    .slice(0, Number(constraints.maxLines) || 3)

  if (lines.length === 0) {
    return { title: 'Listening', lines: [], kind, priority: 0, quiet: true, runningNote }
  }

  return {
    title,
    lines,
    kind,
    priority: Math.max(0, Math.min(4, Number(parsed.priority) || 2)),
    quiet: false,
    runningNote,
  }
}

const handlers = {
  async triage(job) {
    const items = job.input?.items ?? []
    if (items.length === 0) return []
    const lines = items.map(i => `- id ${i.id}: ${i.text}`).join('\n')
    const reply = await think(TRIAGE_PROMPT + lines)
    const parsed = extractJson(reply)
    if (!Array.isArray(parsed)) throw new Error('expected a JSON array')

    // Drop anything referring to an id we were not given, rather than letting
    // it write onto the wrong item.
    const known = new Set(items.map(i => i.id))
    return parsed.filter(r => known.has(r.itemId ?? r.id))
  },

  async 'coach.cue'(job) {
    const input = job.input ?? {}
    const segments = Array.isArray(input.recentSegments) ? input.recentSegments : []
    if (segments.length === 0) {
      return { title: 'Listening', lines: [], kind: 'thought', priority: 0, quiet: true }
    }

    const transcript = segments
      .slice(input.finalNote ? -64 : -32)
      .map(segment => `${segment.speaker || 'someone'}: ${trimText(segment.text, 500)}`)
      .join('\n')
    const mode = input.mode ?? {}
    const prompt = `${COACH_CUE_PROMPT}

Mode:
${JSON.stringify({
  name: mode.name,
  behavior: mode.behavior,
  cueTypes: mode.cueTypes,
  speakUp: mode.speakUp,
  promptLulls: mode.promptLulls,
  periodicRecap: mode.periodicRecap,
}, null, 2)}

Session:
${JSON.stringify(input.session ?? {}, null, 2)}

Previous running note:
${JSON.stringify(input.previousRunningNote ?? null, null, 2)}

Recent transcript:
${transcript}

${input.finalNote ? `The session has ended. This result will become the saved note, not a live interruption.
Read the complete supplied transcript as one conversation. Return kind "recap" and do not return quiet.
The lines become the note visible in the Notes list:
1. A specific one-line title for what is worth remembering, not the opening scene.
2. The most important supported facts, decisions, requests, or connections.
3. An explicit next action or unresolved point only when the transcript supports one; otherwise use another
   durable point or say "No action captured."
Omit filler, greetings, reactions, incidental child/pet directions, and ambient outing details unless the
user clearly asked to preserve them. Never turn a garbled fragment into a task. Preserve the same durable
ideas in runningNote.` : ''}
`

    const reply = await think(prompt, 90_000)
    const parsed = extractJson(reply)
    return normalizeCoachCue(parsed, input.constraints)
  },

  async 'assistant.chat'(job) {
    const input = job.input ?? {}
    const messages = Array.isArray(input.messages) ? input.messages : []
    if (messages.length === 0) throw new Error('assistant chat has no messages')
    const provider = input.provider === 'claude' ? 'claude' : 'chatgpt'
    const command = provider === 'claude' ? CLAUDE_CMD : CHATGPT_CMD
    const conversation = messages
      .slice(-18)
      .map(message => `${message.role === 'assistant' ? 'Assistant' : 'User'}: ${trimText(message.text, 4000)}`)
      .join('\n\n')
    const reply = trimText(await think(ASSISTANT_CHAT_PROMPT + conversation, 300_000, command), 6000)
    if (!reply) throw new Error(`${provider} returned an empty reply`)
    return { provider, text: reply }
  },
}

// ---- the loop -------------------------------------------------------------

async function runOnce() {
  const capabilities = Object.keys(handlers).filter(
    capability => !ONLY_CAPABILITY || capability === ONLY_CAPABILITY,
  )
  let did = 0

  for (const capability of capabilities) {
    let available
    try {
      ;({ jobs: available } = await api(`/jobs?capability=${capability}`))
    } catch (err) {
      console.error(`[runner] cannot reach hub: ${err.message}`)
      return did
    }

    for (const job of available) {
      console.log(`[runner] ${capability} ${job.id.slice(0, 8)} (${job.input?.items?.length ?? 0} items)`)

      // Inspect without claiming. A dry run that took work off the queue and
      // walked away would leave it stranded until the lease lapsed.
      if (DRY) {
        console.log('--- would send ---\n' + JSON.stringify(job.input, null, 2))
        continue
      }

      let claimed
      try {
        // Someone else may have taken it between the list and the claim; that
        // is a normal 409, not an error worth shouting about.
        ;({ job: claimed } = await api(`/jobs/${job.id}/claim`, {
          method: 'POST',
          body: JSON.stringify({ agent: NAME, leaseSeconds: 600 }),
        }))
      } catch {
        continue
      }

      try {
        const result = await handlers[capability](claimed)
        await api(`/jobs/${job.id}/result`, {
          method: 'POST',
          body: JSON.stringify({ agent: NAME, result }),
        })
        console.log(`[runner] done, ${Array.isArray(result) ? result.length : 1} result(s)`)
        did += 1
      } catch (err) {
        console.error(`[runner] failed: ${err.message}`)
        // retry:true lets the hub hand it back out; it gives up after 3 tries
        // rather than looping on something genuinely broken.
        await api(`/jobs/${job.id}/fail`, {
          method: 'POST',
          body: JSON.stringify({ agent: NAME, error: err.message, retry: true }),
        }).catch(() => {})
      }
    }
  }
  return did
}

console.log(`[runner] ${NAME} -> ${HUB}  cmd: ${CMD}${DRY ? '  (dry run)' : ''}`)

if (ONCE) {
  const n = await runOnce()
  console.log(`[runner] ${n} job(s) processed`)
  process.exit(0)
}

await runOnce()
setInterval(() => {
  runOnce().catch(err => console.error(`[runner] ${err.message}`))
}, POLL_SECONDS * 1000)
