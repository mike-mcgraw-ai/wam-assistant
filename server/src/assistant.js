import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const PROVIDERS = new Set(['chatgpt', 'claude'])
const SPACES = new Set(['ops', 'life'])
const MAX_MESSAGES = 80

function clean(value, max = 6000) {
  return String(value ?? '').replace(/\r/g, '').trim().slice(0, max)
}

function safeProvider(value) {
  return PROVIDERS.has(value) ? value : 'chatgpt'
}

function safeSpace(value) {
  return SPACES.has(value) ? value : 'life'
}

function threadKey(space, provider) {
  return `${safeSpace(space)}:${safeProvider(provider)}`
}

export class AssistantChat {
  constructor({ storePath, providerReady = {} }) {
    this.storePath = storePath
    this.providerReady = {
      chatgpt: providerReady.chatgpt === true,
      claude: providerReady.claude === true,
    }
    this.threads = new Map()
    this.#load()
  }

  #load() {
    if (!this.storePath || !existsSync(this.storePath)) return
    try {
      const raw = JSON.parse(readFileSync(this.storePath, 'utf8'))
      for (const thread of raw.threads || []) {
        if (!thread?.key) continue
        this.threads.set(thread.key, {
          ...thread,
          messages: Array.isArray(thread.messages) ? thread.messages.slice(-MAX_MESSAGES) : [],
        })
      }
    } catch (err) {
      console.warn(`[assistant] could not read store: ${err.message}`)
    }
  }

  #persist() {
    if (!this.storePath) return
    try {
      mkdirSync(dirname(this.storePath), { recursive: true })
      writeFileSync(this.storePath, JSON.stringify({ threads: [...this.threads.values()] }, null, 2))
    } catch (err) {
      console.warn(`[assistant] could not write store: ${err.message}`)
    }
  }

  #thread(space, provider) {
    const providerId = safeProvider(provider)
    const spaceId = safeSpace(space)
    const key = threadKey(spaceId, providerId)
    let thread = this.threads.get(key)
    if (!thread) {
      thread = {
        key,
        space: spaceId,
        provider: providerId,
        messages: [],
        pendingJobId: null,
        appliedJobIds: [],
        updatedAt: Date.now(),
      }
      this.threads.set(key, thread)
    }
    return thread
  }

  #sync(thread, jobs) {
    if (!thread.pendingJobId) return
    const job = jobs.get(thread.pendingJobId)
    if (!job) {
      thread.pendingJobId = null
      this.#persist()
      return
    }
    if (job.status === 'done' && !thread.appliedJobIds.includes(job.id)) {
      const text = clean(job.result?.text ?? job.result)
      if (text) {
        thread.messages.push({ id: randomUUID(), role: 'assistant', text, at: job.updatedAt })
      }
      thread.appliedJobIds = [...thread.appliedJobIds, job.id].slice(-40)
      thread.pendingJobId = null
      thread.updatedAt = Date.now()
      thread.messages = thread.messages.slice(-MAX_MESSAGES)
      this.#persist()
    } else if (job.status === 'failed') {
      thread.messages.push({
        id: randomUUID(),
        role: 'system',
        text: clean(job.error || `${thread.provider} failed`, 500),
        at: job.updatedAt,
      })
      thread.pendingJobId = null
      thread.updatedAt = Date.now()
      thread.messages = thread.messages.slice(-MAX_MESSAGES)
      this.#persist()
    }
  }

  snapshot(space, provider, jobs) {
    const thread = this.#thread(space, provider)
    this.#sync(thread, jobs)
    const pending = thread.pendingJobId ? jobs.get(thread.pendingJobId) : null
    return {
      provider: thread.provider,
      ready: this.providerReady[thread.provider],
      busy: Boolean(pending && ['queued', 'claimed'].includes(pending.status)),
      messages: thread.messages.slice(-40),
      updatedAt: thread.updatedAt,
    }
  }

  addTurn({ space, provider, text, clientId }, jobs) {
    const thread = this.#thread(space, provider)
    this.#sync(thread, jobs)
    const body = clean(text, 4000)
    if (!body) return { ok: false, code: 400, error: 'message required' }
    if (!this.providerReady[thread.provider]) {
      return { ok: false, code: 503, error: `${thread.provider} setup needed on the Mac` }
    }
    if (thread.pendingJobId) {
      return { ok: false, code: 409, error: `${thread.provider} is still replying` }
    }

    const dedupe = clean(clientId, 120)
    if (dedupe) {
      const existing = thread.messages.find(message => message.clientId === dedupe)
      if (existing) return { ok: true, existing: true, chat: this.snapshot(space, provider, jobs) }
    }

    thread.messages.push({ id: randomUUID(), role: 'user', text: body, clientId: dedupe || null, at: Date.now() })
    thread.messages = thread.messages.slice(-MAX_MESSAGES)
    const result = jobs.create({
      capability: 'assistant.chat',
      priority: 'now',
      idempotencyKey: dedupe ? `assistant.chat:${thread.key}:${dedupe}` : null,
      input: {
        threadKey: thread.key,
        space: thread.space,
        provider: thread.provider,
        messages: thread.messages.slice(-18).map(({ role, text }) => ({ role, text })),
      },
    })
    if (!result.ok) return result
    thread.pendingJobId = result.job.id
    thread.updatedAt = Date.now()
    this.#persist()
    return { ok: true, chat: this.snapshot(space, provider, jobs) }
  }

  clear(space, provider) {
    const thread = this.#thread(space, provider)
    if (thread.pendingJobId) return { ok: false, code: 409, error: 'wait for the current reply' }
    thread.messages = []
    thread.updatedAt = Date.now()
    this.#persist()
    return { ok: true }
  }
}
