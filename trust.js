/**
 * dsh-a2a-trust — trust engine (pure functions, no IO).
 *
 * Four-dimension trust model with asymmetric EWMA updates:
 * - dimensions: competence / reliability / communication / integrity
 * - good evidence compounds slowly (ALPHA_GOOD), bad evidence bites fast
 *   (ALPHA_BAD) — trust is earned in small steps and lost in big ones;
 * - every dimension tracks its own sample count; below
 *   LOW_CONFIDENCE_SAMPLES the dimension is flagged low-confidence and
 *   downstream consumers (injection, weighting) must skip it.
 *
 * Cross-session identity is the agent *type* fingerprint
 * sha256(name ␟ description ␟ provider ␟ context) built from the durable
 * TeamMemberSnapshot fields of `team/member` events (see SPEC 3.4).
 */

import { createHash } from 'node:crypto'

export const DIMENSIONS = ['competence', 'reliability', 'communication', 'integrity']

export const ALPHA_GOOD = 0.10
export const ALPHA_BAD = 0.30
export const NEUTRAL = 0.5
export const LOW_CONFIDENCE_SAMPLES = 5
export const HISTORY_LIMIT = 64
export const LEDGER_VERSION = 1

const SEP = '\x1f'

/**
 * Agent-type fingerprint for cross-session identity (SPEC 3.4).
 * @param {{name: string, description: string, provider: string, context: string}} member
 * @returns {string} hex digest
 */
export function fingerprint(member) {
  const raw = [member?.name, member?.description, member?.provider, member?.context]
    .map((v) => (typeof v === 'string' ? v : ''))
    .join(SEP)
  return createHash('sha256').update(raw).digest('hex')
}

/** @returns {{value: number, samples: number, updatedAt: number | null}} */
function freshDim() {
  return { value: NEUTRAL, samples: 0, updatedAt: null }
}

/** @returns {Record<string, {value: number, samples: number, updatedAt: number | null}>} */
export function createTrustRecord() {
  const record = {}
  for (const dim of DIMENSIONS) record[dim] = freshDim()
  return record
}

/**
 * One asymmetric EWMA step. `quality` ∈ [0,1]: 1 = strong good,
 * 0.5 = neutral (still counts as a sample), 0 = strong bad.
 * @returns {{record: object, change: {dim: string, before: number, after: number, delta: number}}}
 */
export function applyEvidence(record, dim, quality, now = Date.now()) {
  if (!DIMENSIONS.includes(dim)) throw new Error(`unknown dimension: ${dim}`)
  const q0 = Number(quality)
  const q = Number.isFinite(q0) ? Math.min(1, Math.max(0, q0)) : NEUTRAL
  const prior = record[dim] ?? freshDim()
  const alpha = q >= NEUTRAL ? ALPHA_GOOD : ALPHA_BAD
  const after = alpha * q + (1 - alpha) * prior.value
  const next = {
    value: Math.round(after * 1e6) / 1e6,
    samples: prior.samples + 1,
    updatedAt: now,
  }
  return {
    record: { ...record, [dim]: next },
    change: { dim, before: prior.value, after: next.value, delta: next.value - prior.value },
  }
}

/**
 * Ledger entry for one agent type.
 * @param {{name: string, description: string, provider: string, context: string}} profile
 */
export function createAgentEntry(profile, now = Date.now()) {
  return {
    fingerprint: fingerprint(profile),
    profile: {
      name: String(profile?.name ?? ''),
      description: String(profile?.description ?? ''),
      provider: String(profile?.provider ?? ''),
      context: String(profile?.context ?? ''),
    },
    trust: createTrustRecord(),
    stats: {
      tasksCompleted: 0,
      tasksDeleted: 0,
      toolCalls: 0,
      toolErrors: 0,
      messagesSent: 0,
      responsesOnTime: 0,
      responsesLate: 0,
    },
    history: [],
    firstSeen: now,
    lastSeen: now,
  }
}

/** Equal-weight total score by default; low-confidence dims are skipped. */
export function totalScore(entry, weights = {}) {
  const w = DIMENSIONS.map((d) => (typeof weights[d] === 'number' ? weights[d] : 1 / DIMENSIONS.length))
  const totalW = w.reduce((a, b) => a + b, 0)
  let score = 0
  let used = 0
  for (let i = 0; i < DIMENSIONS.length; i++) {
    const dim = DIMENSIONS[i]
    const rec = entry?.trust?.[dim]
    if (!rec || rec.samples < LOW_CONFIDENCE_SAMPLES) continue
    score += w[i] * rec.value
    used += w[i]
  }
  if (used === 0) return null // nothing confident enough to score
  return Math.round((score / used) * 1e4) / 1e4
}

/** @returns {boolean} dim has fewer samples than the confidence floor. */
export function isLowConfidence(entry, dim) {
  const rec = entry?.trust?.[dim]
  return !rec || rec.samples < LOW_CONFIDENCE_SAMPLES
}

/** Push a bounded history ring entry (immutable). */
export function pushHistory(entry, item, limit = HISTORY_LIMIT) {
  const history = [...(entry.history ?? []), item]
  if (history.length <= limit) return history
  return history.slice(history.length - limit)
}

/** Dashboard projection: per-dim status with confidence flags (pure). */
export function summarize(entry) {
  const dims = {}
  for (const dim of DIMENSIONS) {
    const rec = entry.trust?.[dim] ?? freshDim()
    dims[dim] = {
      value: rec.value,
      samples: rec.samples,
      updatedAt: rec.updatedAt,
      lowConfidence: rec.samples < LOW_CONFIDENCE_SAMPLES,
    }
  }
  return {
    fingerprint: entry.fingerprint,
    profile: entry.profile,
    dims,
    score: totalScore(entry),
    stats: entry.stats ?? {},
    firstSeen: entry.firstSeen,
    lastSeen: entry.lastSeen,
  }
}

