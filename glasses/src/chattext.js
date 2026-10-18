// @ts-check
/**
 * The chat screen's words, shared by the glasses and the WAM Home iPad app
 * (v0.177.0).
 *
 * Mike, 2026-10-18: the iPad's Chat is "laid out the same with the same
 * functions in the same areas of the screen as the glasses", not the same
 * pixels. So the layout is drawn twice (render.ts on the glasses, WAM Home's
 * kiosk.html on the iPad), but every word on it comes from here: change a
 * status or a hint once and both screens say it. Plain JavaScript with type
 * comments: the glasses bundle it, and the hub serves this file to the iPad at
 * /shared/chattext.js.
 *
 * Pure: no state, no DOM, no fetch. Callers pass the chat thread from
 * /assistant/chat and the turn state (recording, reviewing, ...).
 */

/** @typedef {import('./types').AssistantProvider} AssistantProvider */
/** @typedef {import('./types').AssistantChat} AssistantChat */
/** @typedef {AssistantChat['messages'][number]} AssistantMessage */
/**
 * @typedef {object} TurnState  where a spoken turn is, on whichever screen
 * @property {boolean} [recording]
 * @property {boolean} [reviewing]
 * @property {boolean} [sending]
 * @property {boolean} [armed]   first click of the glasses' two-click record
 * @property {string|null} [error]
 */

/** @type {ReadonlyArray<{ id: AssistantProvider, label: string }>} */
export const PROVIDERS = [
  { id: 'chatgpt', label: 'ChatGPT' },
  { id: 'claude', label: 'Claude' },
]

/** @param {AssistantProvider} provider */
export function label(provider) {
  return provider === 'claude' ? 'Claude' : 'ChatGPT'
}

/** @param {string} text */
export function clean(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/** What was asked, without "okay so, ChatGPT, ... thanks". @param {string} text */
export function requestText(text) {
  const cleaned = clean(text)
    .replace(
      /^((ok|okay|alright|so|hey|hi|um|uh|please|thanks|thank you)[,.\s]+)+/i,
      '',
    )
    .replace(/^(chat\s*gpt|chatgpt|claude|codex)[,:\s-]+/i, '')
    .replace(/[,.\s]+(thanks|thank you)[.!?]?$/i, '')
    .trim()
  return cleaned || 'new voice request'
}

/**
 * @param {AssistantProvider} provider
 * @param {AssistantMessage['role']} role
 */
export function linePrefix(provider, role) {
  if (role === 'user') return 'Me: '
  if (role === 'system') return '! '
  return provider === 'claude' ? 'Claude: ' : 'GPT: '
}

/** @param {AssistantChat|null} chat */
export function latestReplyId(chat) {
  const messages = chat?.messages ?? []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'assistant') return messages[index].id
  }
  return null
}

/**
 * The conversation in screen order: newest first, except that a question
 * still waiting for its answer sits under the latest reply, so the reply you
 * are reading stays on top.
 *
 * @param {AssistantChat|null} chat
 * @param {AssistantProvider} provider
 * @returns {Array<{ id: string, role: AssistantMessage['role'], prefix: string, text: string }>}
 */
export function passages(chat, provider) {
  const out = []
  const messages = chat?.messages ?? []
  const replyId = latestReplyId(chat)
  const pendingUser = messages.at(-1)?.role === 'user' && replyId !== null
  /** @param {AssistantMessage} message */
  const passage = message => ({
    id: message.id,
    role: message.role,
    prefix: linePrefix(provider, message.role),
    text: message.role === 'user' ? requestText(message.text) : clean(message.text),
  })
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (pendingUser && index === messages.length - 1) continue
    out.push(passage(messages[index]))
    if (pendingUser && messages[index].id === replyId) out.push(passage(messages[messages.length - 1]))
  }
  return out
}

/**
 * READY / SETUP / CHECKING, or WORKING / QUEUED with how many more wait.
 * `ready` is the thread's own flag, or the hub snapshot's when no thread is loaded.
 *
 * @param {AssistantChat|null} chat
 * @param {boolean|null} ready
 */
export function statusBadge(chat, ready) {
  if (chat?.busy) {
    const status = chat.pending?.status === 'queued' ? 'QUEUED' : 'WORKING'
    const queued = chat.queued ?? 0
    return queued > 0 ? `${status} +${queued}` : status
  }
  if (ready === true) return 'READY'
  if (ready === false) return 'SETUP'
  return 'CHECKING'
}

/** The picker's word for a badge: "ready", "setup needed", "working +2". @param {string} badge */
export function pickerStatus(badge) {
  if (badge.startsWith('READY')) return 'ready'
  if (badge === 'SETUP') return 'setup needed'
  if (badge.startsWith('QUEUED') || badge.startsWith('WORKING')) return badge.toLowerCase()
  return 'checking'
}

/**
 * The chat header's status: the turn first (REC, REVIEW, SENDING, ERROR,
 * ARMED), then the thread's badge.
 *
 * @param {TurnState} turn
 * @param {string} badge
 */
export function headerStatus(turn, badge) {
  if (turn.recording) return 'REC'
  if (turn.reviewing) return 'REVIEW'
  if (turn.sending) return 'SENDING'
  if (turn.error) return 'ERROR'
  if (turn.armed) return 'ARMED'
  return badge
}

/**
 * What the agent is doing, in a few words.
 *
 * @param {AssistantChat|null} chat
 * @param {boolean|null} ready
 */
export function nowText(chat, ready) {
  if (chat?.busy) {
    if (chat.pending?.status === 'queued') return 'reply queued for Mac'
    if (chat.pending?.status === 'claimed') {
      const who = clean(chat.pending.claimedBy ?? '')
      return who ? `${who} drafting reply` : 'drafting reply on Mac'
    }
    return 'reply in progress'
  }
  if (ready === false) return 'setup needed on Mac'
  const messages = chat?.messages ?? []
  const latest = messages.length > 0 ? messages[messages.length - 1] : null
  if (!latest) return ready === true ? 'waiting for your first ask' : 'loading thread'
  if (latest.role === 'system') return clean(latest.text) || 'last turn failed'
  if (latest.role === 'user') return 'sent; waiting for reply'
  return 'ready for next turn'
}

/**
 * The hint under the conversation: what the next press does. `verb` is
 * "click" on the glasses and "tap" on the iPad; nothing else differs.
 *
 * @param {TurnState} turn
 * @param {string} [verb]
 */
export function footerText(turn, verb = 'click') {
  if (turn.error) return turn.error
  if (turn.recording) return `${verb} stops recording`
  if (turn.reviewing) return `${verb} sends - back saves words`
  if (turn.sending) return 'voice is being queued'
  if (turn.armed) return `${verb} again to record`
  return null
}

/** The picker's last line. @param {string} [verb] */
export function pickerHint(verb = 'click') {
  return `${verb} to choose`
}

/** An empty conversation's one line. */
export const EMPTY_CHAT = 'Ready for your next message.'
