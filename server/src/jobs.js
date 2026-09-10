import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'

/**
 * The job queue.
 *
 * The hub does not think. It holds work and hands it out; the thinking happens
 * on whatever machine claims the job — which is normally the Mac at home, using
 * a subscription you already pay for rather than metered API calls.
 *
 * That inverts the usual shape and it is the point: nothing here ever calls a
 * model. If no agent is running, jobs sit in `queued` and the raw items are
 * still on the glasses. Processing is a bonus lane, never the critical path.
 *
 * Claim-with-lease rather than assign: an agent that dies mid-job must not
 * strand the work, and two agents polling the same capability must not both
 * get it.
 */

export const JOB = {
  QUEUED: 'queued',
  CLAIMED: 'claimed',
  BLOCKED: 'blocked',
  DONE: 'done',
  FAILED: 'failed',
}

const MAX_ATTEMPTS = 3

export class Jobs {
  constructor({ storePath, logPath }) {
    this.storePath = storePath
    this.logPath = logPath
    /** @type {Map<string, any>} */
    this.jobs = new Map()
    this.#load()
  }

  #load() {
    if (!this.storePath || !existsSync(this.storePath)) return
    try {
      const raw = JSON.parse(readFileSync(this.storePath, 'utf8'))
      for (const job of raw.jobs || []) this.jobs.set(job.id, job)
      // A restart means every lease is void — whoever held them is gone.
      let released = 0
      for (const job of this.jobs.values()) {
        if (job.status === JOB.CLAIMED) {
          job.status = JOB.QUEUED
          job.claimedBy = null
          released += 1
        }
      }
      console.log(`[jobs] restored ${this.jobs.size}${released ? `, released ${released} stale claim(s)` : ''}`)
    } catch (err) {
      console.warn(`[jobs] could not read store: ${err.message}`)
    }
  }

  #persist() {
    if (!this.storePath) return
    try {
      mkdirSync(dirname(this.storePath), { recursive: true })
      const cutoff = Date.now() - 7 * 86400 * 1000
      const jobs = [...this.jobs.values()].filter(
        j => ![JOB.DONE, JOB.FAILED].includes(j.status) || j.updatedAt > cutoff,
      )
      writeFileSync(this.storePath, JSON.stringify({ jobs }, null, 2))
    } catch (err) {
      console.warn(`[jobs] could not write store: ${err.message}`)
    }
  }

  #log(event) {
    if (!this.logPath) return
    try {
      mkdirSync(dirname(this.logPath), { recursive: true })
      appendFileSync(this.logPath, JSON.stringify(event) + '\n')
    } catch {
      // best effort
    }
  }

  /**
   * Create a job, or return the existing one for the same key.
   *
   * The key is what stops a retrying agent ordering groceries twice. Derived
   * from item + capability when not supplied, which is the sane default: the
   * same work on the same item is the same job.
   */
  create({ itemId = null, capability, input = {}, idempotencyKey = null, priority = 'normal' }) {
    if (!capability) return { ok: false, error: 'capability required' }

    const key =
      idempotencyKey ||
      createHash('sha256').update(`${itemId}:${capability}:${JSON.stringify(input)}`).digest('hex').slice(0, 32)

    const existing = [...this.jobs.values()].find(j => j.idempotencyKey === key)
    if (existing) return { ok: true, job: existing, existing: true }

    const now = Date.now()
    const job = {
      id: randomUUID(),
      itemId,
      capability,
      idempotencyKey: key,
      // 'now' is the on-demand escalation lane: you asked for this one
      // specifically, so it jumps the batch.
      priority: priority === 'now' ? 'now' : 'normal',
      status: JOB.QUEUED,
      input,
      result: null,
      error: null,
      attempts: 0,
      claimedBy: null,
      claimedAt: null,
      leaseExpiresAt: null,
      createdAt: now,
      updatedAt: now,
    }
    this.jobs.set(job.id, job)
    this.#log({ type: 'create', id: job.id, capability, itemId, priority: job.priority, at: now })
    this.#persist()
    return { ok: true, job }
  }

  /** Expired leases go back in the queue. Call before handing work out. */
  reap(now = Date.now()) {
    let released = 0
    for (const job of this.jobs.values()) {
      if (job.status === JOB.CLAIMED && job.leaseExpiresAt && job.leaseExpiresAt < now) {
        job.status = JOB.QUEUED
        job.claimedBy = null
        job.leaseExpiresAt = null
        job.updatedAt = now
        released += 1
        this.#log({ type: 'lease_expired', id: job.id, at: now })
      }
    }
    if (released) this.#persist()
    return released
  }

  /** Queued work, escalated jobs first, then oldest. */
  available(capability = null, now = Date.now()) {
    this.reap(now)
    return [...this.jobs.values()]
      .filter(j => j.status === JOB.QUEUED)
      .filter(j => !capability || j.capability === capability)
      .sort(
        (a, b) =>
          (b.priority === 'now' ? 1 : 0) - (a.priority === 'now' ? 1 : 0) ||
          a.createdAt - b.createdAt,
      )
  }

  claim(id, agent, leaseSeconds = 300, now = Date.now()) {
    this.reap(now)
    const job = this.jobs.get(id)
    if (!job) return { ok: false, code: 404, error: 'unknown job' }
    if (job.status !== JOB.QUEUED) return { ok: false, code: 409, error: `job is ${job.status}` }

    job.status = JOB.CLAIMED
    job.claimedBy = String(agent || 'anon').slice(0, 40)
    job.claimedAt = now
    job.leaseExpiresAt = now + Math.max(30, Math.min(3600, leaseSeconds)) * 1000
    job.attempts += 1
    job.updatedAt = now
    this.#log({ type: 'claim', id, agent: job.claimedBy, attempt: job.attempts, at: now })
    this.#persist()
    return { ok: true, job }
  }

  heartbeat(id, agent, leaseSeconds = 300, now = Date.now()) {
    const job = this.jobs.get(id)
    if (!job) return { ok: false, code: 404, error: 'unknown job' }
    if (job.claimedBy !== agent) return { ok: false, code: 409, error: 'not your job' }
    job.leaseExpiresAt = now + Math.max(30, Math.min(3600, leaseSeconds)) * 1000
    job.updatedAt = now
    this.#persist()
    return { ok: true, job }
  }

  finish(id, agent, result, now = Date.now()) {
    const job = this.jobs.get(id)
    if (!job) return { ok: false, code: 404, error: 'unknown job' }
    // A lapsed lease means someone else may hold it now; refuse rather than
    // clobber whatever they are doing.
    if (job.claimedBy !== agent) return { ok: false, code: 409, error: 'not your job' }
    job.status = JOB.DONE
    job.result = result ?? null
    job.leaseExpiresAt = null
    job.updatedAt = now
    this.#log({ type: 'done', id, agent, at: now })
    this.#persist()
    return { ok: true, job }
  }

  fail(id, agent, error, retry = true, now = Date.now()) {
    const job = this.jobs.get(id)
    if (!job) return { ok: false, code: 404, error: 'unknown job' }
    if (job.claimedBy !== agent) return { ok: false, code: 409, error: 'not your job' }

    const canRetry = retry && job.attempts < MAX_ATTEMPTS
    job.status = canRetry ? JOB.QUEUED : JOB.FAILED
    job.error = String(error || 'unknown').slice(0, 300)
    job.claimedBy = null
    job.leaseExpiresAt = null
    job.updatedAt = now
    this.#log({ type: canRetry ? 'retry' : 'failed', id, agent, error: job.error, attempt: job.attempts, at: now })
    this.#persist()
    return { ok: true, job, requeued: canRetry }
  }

  get(id) {
    return this.jobs.get(id) ?? null
  }

  /** Counts for the glasses header: how much is waiting on the Mac. */
  summary(now = Date.now()) {
    this.reap(now)
    const counts = { queued: 0, claimed: 0, blocked: 0, failed: 0 }
    for (const job of this.jobs.values()) {
      if (job.status in counts) counts[job.status] += 1
    }
    return counts
  }
}
