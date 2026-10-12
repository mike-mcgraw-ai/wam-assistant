import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const PROVIDERS = new Set(['chatgpt', 'claude'])
const SPACES = new Set(['ops', 'life'])
const MAX_MESSAGES = 80
const MAX_QUEUED_TURNS = 20

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
          queuedTurns: Array.isArray(thread.queuedTurns) ? thread.queuedTurns.slice(0, MAX_QUEUED_TURNS) : [],
          activeSource: thread.activeSource ?? null,
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
        queuedTurns: [],
        activeSource: null,
        updatedAt: Date.now(),
      }
      this.threads.set(key, thread)
    }
    return thread
  }

  #startTurn(thread, turn, jobs) {
    thread.messages.push({
      id: randomUUID(),
      role: 'user',
      text: turn.text,
      clientId: turn.clientId || null,
      at: Date.now(),
    })
    thread.messages = thread.messages.slice(-MAX_MESSAGES)
    const result = jobs.create({
      capability: 'assistant.chat',
      priority: 'now',
      idempotencyKey: turn.clientId ? `assistant.chat:${thread.key}:${turn.clientId}` : null,
      input: {
        threadKey: thread.key,
        space: thread.space,
        provider: thread.provider,
        messages: thread.messages.slice(-18).map(({ role, text }) => ({ role, text })),
      },
    })
    if (!result.ok) {
      thread.messages.pop()
      return result
    }
    thread.pendingJobId = result.job.id
    thread.activeSource = turn.source ?? null
    thread.updatedAt = Date.now()
    return { ok: true, job: result.job }
  }

  #startQueued(thread, jobs) {
    if (thread.pendingJobId || thread.queuedTurns.length === 0) return false
    const next = thread.queuedTurns[0]
    const started = this.#startTurn(thread, next, jobs)
    if (!started.ok) return false
    thread.queuedTurns.shift()
    return true
  }

  #sync(thread, jobs) {
    let changed = false
    if (!thread.pendingJobId) {
      changed = this.#startQueued(thread, jobs)
      if (changed) this.#persist()
      return changed
    }
    const job = jobs.get(thread.pendingJobId)
    if (!job) {
      thread.pendingJobId = null
      thread.activeSource = null
      changed = true
    } else if (job.status === 'done') {
      if (!thread.appliedJobIds.includes(job.id)) {
        const text = clean(job.result?.text ?? job.result)
        if (text) {
          thread.messages.push({ id: randomUUID(), role: 'assistant', text, at: job.updatedAt })
        }
        thread.appliedJobIds = [...thread.appliedJobIds, job.id].slice(-40)
      }
      thread.pendingJobId = null
      thread.activeSource = null
      thread.updatedAt = Date.now()
      thread.messages = thread.messages.slice(-MAX_MESSAGES)
      changed = true
    } else if (job.status === 'failed') {
      thread.messages.push({
        id: randomUUID(),
        role: 'system',
        text: clean(job.error || `${thread.provider} failed`, 500),
        at: job.updatedAt,
      })
      thread.pendingJobId = null
      thread.activeSource = null
      thread.updatedAt = Date.now()
      thread.messages = thread.messages.slice(-MAX_MESSAGES)
      changed = true
    }
    if (!thread.pendingJobId && this.#startQueued(thread, jobs)) changed = true
    if (changed) this.#persist()
    return changed
  }

  syncAll(jobs) {
    let changed = 0
    for (const thread of this.threads.values()) {
      if (this.#sync(thread, jobs)) changed += 1
    }
    return changed
  }

  snapshot(space, provider, jobs) {
    const thread = this.#thread(space, provider)
    this.#sync(thread, jobs)
    const pending = thread.pendingJobId ? jobs.get(thread.pendingJobId) : null
    return {
      provider: thread.provider,
      ready: this.providerReady[thread.provider],
      busy: Boolean(pending && ['queued', 'claimed'].includes(pending.status)),
      queued: thread.queuedTurns.length,
      activeSource: thread.activeSource,
      pending: pending
        ? {
            // The job id, so a stuck turn can be named. Nothing else returned
            // it, which meant diagnosis started by reading jobs.json off disk.
            id: pending.id,
            status: pending.status,
            claimedBy: pending.claimedBy ?? null,
            attempts: pending.attempts ?? 0,
            createdAt: pending.createdAt ?? 0,
            updatedAt: pending.updatedAt ?? 0,
          }
        : null,
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

    const result = this.#startTurn(thread, { text: body, clientId: dedupe || null, source: null }, jobs)
    if (!result.ok) return result
    this.#persist()
    return { ok: true, chat: this.snapshot(space, provider, jobs) }
  }

  queueTurn({ space, provider, text, clientId, source }, jobs) {
    const thread = this.#thread(space, provider)
    this.#sync(thread, jobs)
    const body = clean(text, 4000)
    if (!body) return { ok: false, code: 400, error: 'message required' }
    if (!this.providerReady[thread.provider]) {
      return { ok: false, code: 503, error: `${thread.provider} setup needed on the Mac` }
    }

    const dedupe = clean(clientId, 120)
    const known = dedupe && (
      thread.messages.some(message => message.clientId === dedupe) ||
      thread.queuedTurns.some(turn => turn.clientId === dedupe) ||
      thread.activeSource?.clientId === dedupe
    )
    if (known) {
      return { ok: true, existing: true, chat: this.snapshot(space, provider, jobs) }
    }
    if (thread.queuedTurns.length >= MAX_QUEUED_TURNS) {
      return { ok: false, code: 409, error: `${thread.provider} queue is full` }
    }

    thread.queuedTurns.push({
      id: randomUUID(),
      text: body,
      clientId: dedupe || null,
      source: source && typeof source === 'object' ? source : null,
      queuedAt: Date.now(),
    })
    this.#startQueued(thread, jobs)
    thread.updatedAt = Date.now()
    this.#persist()
    return { ok: true, chat: this.snapshot(space, provider, jobs) }
  }

  clear(space, provider) {
    const thread = this.#thread(space, provider)
    if (thread.pendingJobId || thread.queuedTurns.length > 0) {
      return { ok: false, code: 409, error: 'wait for current and queued work' }
    }
    thread.messages = []
    thread.updatedAt = Date.now()
    this.#persist()
    return { ok: true }
  }
}
