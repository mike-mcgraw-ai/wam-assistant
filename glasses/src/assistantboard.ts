/**
 * Chat screens, laid out across all four 288x144 tiles.
 *
 * The picker is a two-agent overview. Active chat keeps the transcript in the
 * left column and the working state in the right column so status no longer
 * steals rows from the actual answer.
 */
import type { AssistantPanelBlock } from './fullpanel'
import { wrap } from './format'
import type { UiState } from './render'
import type { AssistantChat, AssistantMessage, AssistantProvider } from './types'

const PROVIDERS: AssistantProvider[] = ['chatgpt', 'claude']
const CHAT_BLOCK_ROWS = 7
const CHAT_TRANSCRIPT_ROWS = CHAT_BLOCK_ROWS * 2
const CHAT_LINE_CHARS = 25

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function requestText(text: string): string {
  const cleaned = clean(text)
    .replace(
      /^((ok|okay|alright|so|hey|hi|um|uh|please|thanks|thank you)[,.\s]+)+/i,
      '',
    )
    .replace(/^((chat\s*gpt|chatgpt|claude|codex)[,:\s-]+)+/i, '')
    .replace(/[,.\s]+(thanks|thank you)[.!?]?$/i, '')
    .trim()
  return cleaned || 'waiting for your ask'
}

function label(provider: AssistantProvider): string {
  return provider === 'claude' ? 'Claude' : 'ChatGPT'
}

function prefix(provider: AssistantProvider, role: AssistantMessage['role']): string {
  if (role === 'user') return 'Me: '
  if (role === 'system') return '! '
  return provider === 'claude' ? 'Claude: ' : 'GPT: '
}

function age(at: number | null | undefined, now = Date.now()): string {
  if (!at) return ''
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

function chatFor(state: UiState, provider: AssistantProvider): AssistantChat | null {
  if (state.view.kind === 'assistant' && state.view.phase === 'chat' && state.view.provider === provider) {
    return state.assistantChat ?? state.assistantThreads[provider] ?? null
  }
  return state.assistantThreads[provider] ?? null
}

function assistantReady(state: UiState, provider: AssistantProvider, chat: AssistantChat | null): boolean | null {
  if (chat) return chat.ready
  const ready = state.snapshot?.assistant?.[provider]
  return typeof ready === 'boolean' ? ready : null
}

function latestMessage(chat: AssistantChat | null): AssistantMessage | null {
  const messages = chat?.messages ?? []
  return messages.length > 0 ? messages[messages.length - 1] : null
}

function latestUser(chat: AssistantChat | null): AssistantMessage | null {
  const messages = chat?.messages ?? []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') return messages[index]
  }
  return null
}

function latestReply(chat: AssistantChat | null): AssistantMessage | null {
  const messages = chat?.messages ?? []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'assistant' || messages[index].role === 'system') return messages[index]
  }
  return null
}

function statusBadge(state: UiState, provider: AssistantProvider, chat: AssistantChat | null): string {
  if (chat?.busy) return chat.pending?.status === 'queued' ? 'QUEUED' : 'WORKING'
  const ready = assistantReady(state, provider, chat)
  if (ready === true) return 'READY'
  if (ready === false) return 'SETUP'
  return 'CHECKING'
}

function nowText(state: UiState, provider: AssistantProvider, chat: AssistantChat | null): string {
  if (state.assistantRecording) return 'Capturing the next voice turn'
  if (state.assistantReviewing) return 'Holding the stopped transcript for review'
  if (state.assistantSending) return `Queuing the turn for ${label(provider)}`
  if (chat?.busy) {
    if (chat.pending?.status === 'queued') return 'Waiting for the Mac runner to claim it'
    const who = clean(chat.pending?.claimedBy ?? '')
    return who ? `${who} is drafting the reply` : 'Mac runner is drafting the reply'
  }
  const ready = assistantReady(state, provider, chat)
  if (ready === false) return 'Mac setup is missing'
  const latest = latestMessage(chat)
  if (!latest) return ready === true ? 'Ready for the first ask' : 'Loading the thread'
  if (latest.role === 'user') return 'Sent; waiting for a reply'
  if (latest.role === 'system') return 'Last turn needs attention'
  return 'Ready for your next turn'
}

function goalText(state: UiState, provider: AssistantProvider, chat: AssistantChat | null): string {
  if (assistantReady(state, provider, chat) === false) return 'connect the Mac agent'
  const latest = latestUser(chat)
  return latest ? requestText(latest.text) : 'waiting for your ask'
}

function messageText(message: AssistantMessage | null, fallback: string): string {
  if (!message) return fallback
  const body = clean(message.text)
  if (!body) return fallback
  return message.role === 'system' ? `Error: ${body}` : body
}

function capturedAsk(state: UiState): string {
  const raw = clean((state.coachSession?.recentSegments ?? []).map(segment => segment.text).join(' '))
  if (raw) return requestText(raw)
  if (state.assistantRecording) return 'capturing your ask'
  if (state.assistantSending) return 'waiting for transcription'
  return 'waiting for your ask'
}

function activeGoalText(state: UiState, provider: AssistantProvider, chat: AssistantChat | null): string {
  if (state.assistantRecording || state.assistantReviewing || state.assistantSending) return capturedAsk(state)
  return goalText(state, provider, chat)
}

function activeActionText(state: UiState, provider: AssistantProvider, chat: AssistantChat | null): string {
  if (state.assistantRecording) return 'Click stops to review'
  if (state.assistantReviewing) return 'Click sends; back discards'
  if (state.assistantSending) return 'Waiting for speech cleanup'
  if (chat?.busy) return 'Click refreshes status'
  if (assistantReady(state, provider, chat) === false) return 'Finish Mac setup first'
  return 'Click records next ask'
}

function passageRows(provider: AssistantProvider, role: AssistantMessage['role'], text: string): string[] {
  const head = prefix(provider, role)
  const body = role === 'user' ? requestText(text) : clean(text)
  const width = Math.max(8, CHAT_LINE_CHARS - head.length)
  const rows = wrap(body || ' ', width)
  return rows.map((row, index) => `${index === 0 ? head : ' '.repeat(head.length)}${row}`)
}

function activeTranscriptRows(state: UiState, provider: AssistantProvider, chat: AssistantChat | null): string[] {
  if (state.assistantRecording || state.assistantReviewing || state.assistantSending) {
    const ask = capturedAsk(state)
    if (ask && ask !== 'capturing your ask' && ask !== 'waiting for transcription') {
      return passageRows(provider, 'user', ask)
    }
    if (state.assistantReviewing) return ['No ask captured yet.']
    if (state.assistantSending) return ['Waiting for transcription.']
    return ['Recording next ask.']
  }

  const messages = chat?.messages ?? []
  const rows: string[] = []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    rows.push(...passageRows(provider, messages[index].role, messages[index].text))
  }
  return rows.length > 0 ? rows : ['Ready for your next message.']
}

function aimText(state: UiState, provider: AssistantProvider, chat: AssistantChat | null): string {
  const text = goalText(state, provider, chat)
  return text === 'waiting for your ask' ? 'ready for the next useful ask' : text
}

function providerSummaryBlock(state: UiState, provider: AssistantProvider): AssistantPanelBlock {
  const chat = chatFor(state, provider)
  const selected = state.view.kind === 'assistant' && state.view.phase === 'providers'
    && PROVIDERS[state.view.cursor] === provider
  return {
    title: `${selected ? '> ' : ''}${label(provider)}`,
    note: statusBadge(state, provider, chat),
    rows: [
      aimText(state, provider, chat),
      nowText(state, provider, chat),
    ],
    dim: assistantReady(state, provider, chat) === false,
  }
}

function providerReplyBlock(state: UiState, provider: AssistantProvider): AssistantPanelBlock {
  const chat = chatFor(state, provider)
  const reply = latestReply(chat)
  return {
    title: `${label(provider)} ANSWER`,
    note: age(reply?.at ?? chat?.updatedAt),
    rows: [messageText(reply, 'No reply yet.')],
    dim: !reply,
  }
}

function activeChatBlocks(state: UiState, provider: AssistantProvider): AssistantPanelBlock[] {
  const chat = chatFor(state, provider)
  const rows = activeTranscriptRows(state, provider, chat)
  const max = Math.max(0, rows.length - CHAT_TRANSCRIPT_ROWS)
  const scroll = state.view.kind === 'assistant' && state.view.phase === 'chat'
    ? Math.max(0, Math.min(max, state.view.scroll ?? 0))
    : 0
  const visible = rows.slice(scroll, scroll + CHAT_TRANSCRIPT_ROWS)
  const top = visible.slice(0, CHAT_BLOCK_ROWS)
  const bottom = visible.slice(CHAT_BLOCK_ROWS, CHAT_TRANSCRIPT_ROWS)
  const status = statusBadge(state, provider, chat)
  const scrollNote = max > 0 ? (scroll > 0 ? `back ${scroll}` : 'newest') : status

  return [
    {
      title: `${label(provider)} CHAT`,
      note: scrollNote,
      rows: top,
      prewrapped: true,
    },
    {
      title: 'GOAL',
      note: status,
      rows: [activeGoalText(state, provider, chat)],
      dim: assistantReady(state, provider, chat) === false,
    },
    {
      title: 'CHAT MORE',
      note: max > 0 ? `${Math.min(rows.length, scroll + CHAT_TRANSCRIPT_ROWS)}/${rows.length}` : '',
      rows: bottom,
      prewrapped: true,
    },
    {
      title: 'NOW',
      note: '',
      rows: [
        nowText(state, provider, chat),
        activeActionText(state, provider, chat),
      ],
      dim: assistantReady(state, provider, chat) === false,
    },
  ]
}

export function assistantBoardScrollMax(state: UiState): number {
  if (state.view.kind !== 'assistant' || state.view.phase !== 'chat' || state.assistantRecording) return 0
  const chat = chatFor(state, state.view.provider)
  return Math.max(0, activeTranscriptRows(state, state.view.provider, chat).length - CHAT_TRANSCRIPT_ROWS)
}

export function assistantBoard(state: UiState): AssistantPanelBlock[] | null {
  if (state.view.kind !== 'assistant') return null
  if (state.view.phase === 'providers') {
    return [
      providerSummaryBlock(state, 'chatgpt'),
      providerSummaryBlock(state, 'claude'),
      providerReplyBlock(state, 'chatgpt'),
      providerReplyBlock(state, 'claude'),
    ]
  }
  return activeChatBlocks(state, state.view.provider)
}
