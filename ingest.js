/**
 * dsh-a2a-trust — event-to-evidence extractor (SPEC 3.2 mapping).
 *
 * A stateful Ingestor fed with (sessionId, event) pairs from the live
 * `ctx.on('session/event')` stream (or the backfill reader). It tracks
 * roster membership, task-board state transitions, tool call pairing, and
 * inbox-splice → assistant-message response timing, and emits Evidence
 * records the trust engine can apply.
 *
 * Attribution model (verified against real session logs):
 * - `team/member` events carry member.id (bare UUID) and land on the Lead
 *   session log; teammate sessions use the bare UUID as their directory /
 *   session id, so sessionId resolution is exact-match first, then
 *   suffix-match (handles `session-<uuid>` Lead directories).
 * - `team/task` carries task snapshots with ownerId (optional SessionId).
 * - `tool/call` → `tool/result` pair by callId; the executor is the session
 *   that emitted tool/call. tool/result error flag: V3 requires
 *   data.error ⇒ message.content[0].isError === true; we read both shapes.
 *
 * Evidence quality scale (L0 hard metrics, discrete):
 * - 1.0 strong good (task completed, tool success, on-time response)
 * - 0.7 mild good  (message sent — communication behaviour exists)
 * - 0.5 neutral    (no trust move; still a sample where applicable)
 * - 0.0 strong bad (tool error, very late response)
 */

import { fingerprint } from './trust.js'

/** Response-latency bands for communication evidence. */
export const RESPONSE_GOOD_MS = 60_000
export const RESPONSE_NEUTRAL_MS = 600_000

/** Bounded pairing tables: unpaired entries are dropped beyond this. */
const MAX_PENDING_TOOLS = 512
const MAX_PENDING_INBOX = 128
const MAX_TASKS = 256

/**
 * @typedef {{fingerprint: string, dim: string, quality: number, kind: string, detail: object, time: number}} Evidence
 */
export class Ingestor {
  constructor() {
    /** @type {Map<string, {fingerprint: string, profile: object}>} sessionId → member */
    this.members = new Map()
    /** @type {Map<string, {status: string, ownerId?: string, revision: number}>} */
    this.tasks = new Map()
    /** @type {Map<string, {sessionId: string, name: string, time: number}>} callId → call */
    this.pendingTools = new Map()
    /** @type {Map<string, number>} sessionId → last inbox-splice time */
    this.pendingInbox = new Map()
    /** @type {Map<string, number>} bare-uuid → last inbox-splice time (suffix key) */
    this.inboxByUuid = new Map()
  }

  /**
   * Resolve a sessionId (or session directory name) to a known member.
   * Exact match first, then suffix match for `session-<uuid>` style ids.
   * @returns {{fingerprint: string, profile: object} | undefined}
   */
  resolveMember(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    const exact = this.members.get(sessionId)
    if (exact !== undefined) return exact
    for (const [id, member] of this.members) {
      if (sessionId.endsWith(id) || id.endsWith(sessionId)) return member
    }
    return undefined
  }

  /**
   * Feed one event; returns zero or more Evidence records.
   * @param {string} sessionId session that owns this event
   * @param {{type: string, seq?: number, time?: number, data?: object}} event
   * @returns {Evidence[]}
   */
  feed(sessionId, event) {
    if (!event || typeof event.type !== 'string') return []
    const time = typeof event.time === 'number' ? event.time : Date.now()
    switch (event.type) {
      case 'team/member': return this.onMember(event, time)
      case 'team/task': return this.onTask(event, time)
      case 'tool/call': return this.onToolCall(sessionId, event, time)
      case 'tool/result': return this.onToolResult(sessionId, event, time)
      case 'agent/inbox/spliced': return this.onInboxSpliced(event, time)
      case 'user/message': return this.onUserMessage(event, time)
      case 'assistant/message': return this.onAssistantMessage(sessionId, time)
      default: return []
    }
  }

  onMember(event, time) {
    const member = event.data?.member
    if (!member || typeof member.id !== 'string') return []
    const profile = {
      name: member.name ?? '',
      description: member.description ?? '',
      provider: member.provider ?? '',
      context: member.context ?? '',
    }
    const fp = fingerprint(profile)
    this.members.set(member.id, { fingerprint: fp, profile })
    // Registration is trust-neutral but flows through the same audit path
    // so the ledger's profile survives replay/backfill.
    return [{ fingerprint: fp, dim: null, quality: null, kind: 'member-registered', profile, detail: profile, time }]
  }

  onTask(event, time) {
    const task = event.data?.task
    if (!task || typeof task.id !== 'string') return []
    const prev = this.tasks.get(task.id)
    this.tasks.set(task.id, {
      status: task.status ?? 'pending',
      ownerId: typeof task.ownerId === 'string' ? task.ownerId : undefined,
      revision: task.revision ?? 0,
    })
    if (this.tasks.size > MAX_TASKS) {
      const oldest = this.tasks.keys().next().value
      this.tasks.delete(oldest)
    }
    if (prev === undefined || prev.status === task.status) return []
    // Status transition evidence. `deleted` is semantically ambiguous
    // (cleanup vs abandonment) — recorded in stats, no trust move.
    if (task.status === 'completed' && task.ownerId) {
      const member = this.resolveMember(task.ownerId)
      if (!member) return []
      return [
        ev(member.fingerprint, 'competence', 1.0, 'task-completed',
          { taskId: task.id, subject: task.subject }, time),
        ev(member.fingerprint, 'reliability', 1.0, 'task-completed',
          { taskId: task.id, subject: task.subject }, time),
      ]
    }
    return []
  }

  onToolCall(sessionId, event, time) {
    const callId = event.data?.callId
    if (typeof callId !== 'string') return []
    if (this.pendingTools.size >= MAX_PENDING_TOOLS) {
      const oldest = this.pendingTools.keys().next().value
      this.pendingTools.delete(oldest)
    }
    this.pendingTools.set(callId, {
      sessionId: sessionId ?? '',
      name: event.data?.name ?? '',
      time,
    })
    return []
  }

  onToolResult(sessionId, event, time) {
    const data = event.data ?? {}
    const callId = data.message?.source?.callId ?? data.callId
    if (typeof callId !== 'string') return []
    const call = this.pendingTools.get(callId)
    if (call === undefined) return [] // result without a tracked call — skip
    this.pendingTools.delete(callId)
    const member = this.resolveMember(call.sessionId || sessionId)
    if (!member) return [] // unattributable (e.g. lead-only session) — skip
    const isError = readToolError(data)
    return [ev(member.fingerprint, 'competence', isError ? 0.0 : 0.8,
      isError ? 'tool-error' : 'tool-success',
      { callId, tool: call.name, durationMs: time - call.time }, time)]
  }

  onInboxSpliced(event, time) {
    const target = event.data?.target
    if (typeof target !== 'string' || target === 'next-turn') return []
    // `next-turn` targets are the Lead's own user-input splice, not a
    // teammate mailbox delivery — never a communication-evidence anchor.
    if (this.pendingInbox.size >= MAX_PENDING_INBOX) {
      const oldest = this.pendingInbox.keys().next().value
      this.pendingInbox.delete(oldest)
      this.inboxByUuid.delete(oldest)
    }
    this.pendingInbox.set(target, time)
    this.inboxByUuid.set(target.replace(/^session-/, ''), time)
    return []
  }

  onUserMessage(event, time) {
    const source = event.data?.source
    if (source?.kind !== 'team-message') return []
    const senderId = source.senderId ?? source.teamId
    if (typeof senderId !== 'string') return []
    const member = this.resolveMember(senderId)
    if (!member) return []
    return [ev(member.fingerprint, 'communication', 0.7, 'message-sent',
      { messageId: source.messageId }, time)]
  }

  onAssistantMessage(sessionId, time) {
    const spliceTime = this.pendingInbox.get(sessionId)
      ?? this.inboxByUuid.get(String(sessionId ?? '').replace(/^session-/, ''))
    if (spliceTime === undefined) return []
    this.pendingInbox.delete(sessionId)
    this.inboxByUuid.delete(String(sessionId ?? '').replace(/^session-/, ''))
    const member = this.resolveMember(sessionId)
    if (!member) return []
    const latency = time - spliceTime
    const quality = latency <= RESPONSE_GOOD_MS ? 1.0
      : latency <= RESPONSE_NEUTRAL_MS ? 0.5 : 0.0
    return [ev(member.fingerprint, 'communication', quality, 'response-latency',
      { latencyMs: latency }, time)]
  }
}

/**
 * V2/V3-tolerant tool error flag (SPEC 3.6): V3 guarantees
 * data.error ⇒ message.content[0].isError === true; V2 may carry either.
 */
function readToolError(data) {
  if (data.error !== undefined) return true
  const first = data.message?.content?.[0]
  return first?.isError === true || first?.isError === 'true'
}

function ev(fingerprint_, dim, quality, kind, detail, time) {
  return { fingerprint: fingerprint_, dim, quality, kind, detail, time }
}
