/**
 * dsh-a2a-trust — durable trust store (SPEC 3.5).
 *
 * Audit-first discipline:
 * - audit.jsonl is the source of truth: every trust change is appended
 *   BEFORE the ledger snapshot is updated (crash between the two leaves a
 *   stale snapshot, never a lost change — rebuild closes the gap);
 * - ledger.json is a rebuildable projection, written atomically
 *   (tmp → rename) with one prior generation kept as .bak;
 * - a cross-process mkdir lock with PID liveness detection and stale
 *   takeover guards concurrent profile services (memory-lite proven
 *   pattern);
 * - rebuildFromAudit replays the audit log into an equivalent ledger —
 *   the equivalence is asserted by tests.
 *
 * Home directory: ~/.dsh/dsh-a2a-trust (override with A2A_TRUST_HOME).
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, stat, rm, appendFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

import {
  DIMENSIONS, LEDGER_VERSION, createAgentEntry, applyEvidence, pushHistory, summarize,
} from './trust.js'

const AUDIT = 'audit.jsonl'
const LEDGER = 'ledger.json'
const LOCK_STALE_MS = 30_000

/** Resolve the store directory (env override wins — required by tests). */
export function homeDir(env = process.env) {
  if (typeof env.A2A_TRUST_HOME === 'string' && env.A2A_TRUST_HOME !== '') {
    return env.A2A_TRUST_HOME
  }
  return join(homedir(), '.dsh', 'dsh-a2a-trust')
}

export function paths(dir = homeDir()) {
  return {
    dir,
    audit: join(dir, AUDIT),
    ledger: join(dir, LEDGER),
    ledgerBak: join(dir, `${LEDGER}.bak`),
    lockDir: join(dir, '.ledger.lock'),
    ownerFile: join(dir, '.ledger.lock', 'owner'),
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

/**
 * Acquire the cross-process ledger lock; resolves a release function.
 * Stale takeover requires BOTH lock age > LOCK_STALE_MS and dead owner.
 */
export async function acquireLock(dir, { waitMs = 2000 } = {}) {
  const p = paths(dir)
  // The store directory may not exist yet (first-ever run): create it
  // before the non-recursive lock mkdir below — without this the very
  // first backfill on a fresh machine dies with ENOENT (caught by the
  // real-environment e2e, missed by tests that always pre-create tmp dirs).
  // p.dir, not the raw arg: callers may pass undefined to mean "default".
  await mkdir(p.dir, { recursive: true })
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      await mkdir(p.lockDir)
      await writeFile(p.ownerFile, JSON.stringify({ pid: process.pid, ts: Date.now() }), 'utf8')
      return async () => { await rm(p.lockDir, { recursive: true, force: true }) }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      // exists — check staleness
      let stale = false
      try {
        const st = await stat(p.lockDir)
        let ownerPid = null
        try { ownerPid = JSON.parse(await readFile(p.ownerFile, 'utf8')).pid } catch { /* unreadable owner — treat as dead */ }
        if ((Date.now() - st.mtimeMs > LOCK_STALE_MS && (ownerPid === null || !pidAlive(ownerPid)))
          || (ownerPid !== null && !pidAlive(ownerPid))) {
          stale = true
        }
      } catch { /* lock vanished — retry */ }
      if (stale) {
        await rm(p.lockDir, { recursive: true, force: true })
        continue
      }
      if (Date.now() >= deadline) throw new Error(`ledger lock busy: ${p.lockDir}`)
      await new Promise((r) => setTimeout(r, 50))
    }
  }
}

/** Load the ledger snapshot; a missing or corrupt file starts fresh. */
export async function loadLedger(dir = homeDir()) {
  const p = paths(dir)
  try {
    const raw = await readFile(p.ledger, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed?.version !== LEDGER_VERSION) return freshLedger()
    return parsed
  } catch (e) {
    if (e.code === 'ENOENT') return freshLedger()
    // corrupt snapshot — try the prior generation before giving up
    try {
      const bak = JSON.parse(await readFile(p.ledgerBak, 'utf8'))
      if (bak?.version === LEDGER_VERSION) return bak
    } catch { /* no usable backup */ }
    return freshLedger()
  }
}

function freshLedger(now = Date.now()) {
  return { version: LEDGER_VERSION, updatedAt: now, agents: {} }
}

/** Atomic snapshot write: tmp → rename, previous generation kept as .bak. */
export async function saveLedger(dir, ledger) {
  const p = paths(dir)
  await mkdir(p.dir, { recursive: true })
  // updatedAt is owned by the caller (mutation time), not by the write
  // itself — tests assert exact values and replay must stay deterministic.
  const next = { ...ledger, version: LEDGER_VERSION }
  const tmp = join(p.dir, `${LEDGER}.tmp-${process.pid}`)
  await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8')
  if (existsSync(p.ledger)) {
    try { await rename(p.ledger, p.ledgerBak) } catch { /* first write — no prior */ }
  }
  await rename(tmp, p.ledger)
  return next
}

/**
 * Append one audit line (first-class record). Never throws for content —
 * a failed append must surface as an error from the caller's mutation path
 * so the ledger is never updated past a lost audit row.
 */
export async function appendAudit(dir, record) {
  const p = paths(dir)
  await mkdir(p.dir, { recursive: true })
  await appendFile(p.audit, `${JSON.stringify(record)}\n`, 'utf8')
}

/**
 * Apply one evidence record to the ledger (pure transformation); returns
 * the updated ledger and the audit row to append.
 * @param {object} ledger current snapshot
 * @param {{fingerprint: string, dim: string, quality: number, kind: string, detail: object, time: number}} evidence
 * @param {object} [ctx] {session, teamId} provenance for the audit row
 */
export function applyToLedger(ledger, evidence, ctx = {}) {
  // Profile registration is a trust-neutral ledger mutation: it creates or
  // refreshes the agent-type entry without touching trust values.
  if (evidence.kind === 'member-registered') {
    const profile = normalizeProfile(evidence.profile ?? evidence.detail)
    let entry = ledger.agents[evidence.fingerprint]
    entry = entry === undefined
      ? createAgentEntry(profile, evidence.time)
      : { ...entry, profile, lastSeen: Math.max(entry.lastSeen ?? 0, evidence.time) }
    const nextLedger = {
      ...ledger,
      updatedAt: Math.max(ledger.updatedAt ?? 0, evidence.time),
      agents: { ...ledger.agents, [evidence.fingerprint]: entry },
    }
    const auditRow = {
      time: evidence.time,
      session: ctx.session ?? null,
      teamId: ctx.teamId ?? null,
      kind: 'member-registered',
      subject: evidence.fingerprint,
      subjectName: entry.profile.name,
      dim: null,
      quality: null,
      delta: null,
      before: null,
      after: null,
      evidence: { profile },
    }
    return { ledger: nextLedger, auditRow, change: null }
  }
  let entry = ledger.agents[evidence.fingerprint]
  if (entry === undefined) {
    // Unknown agent type: live path normally registers via team/member
    // first; a stray evidence row without registration keeps an empty
    // profile (backfill replays in seq order, so this is rare).
    entry = createAgentEntry({ name: '', description: '', provider: '', context: '' }, evidence.time)
  }
  const { record: trust, change } = applyEvidence(entry.trust, evidence.dim, evidence.quality, evidence.time)
  const stats = bumpStats(entry.stats ?? {}, evidence)
  const history = pushHistory(entry, {
    time: evidence.time, kind: evidence.kind, dim: evidence.dim,
    quality: evidence.quality, detail: evidence.detail,
  })
  const nextEntry = {
    ...entry,
    trust,
    stats,
    history,
    lastSeen: Math.max(entry.lastSeen ?? 0, evidence.time),
  }
  const auditRow = {
    time: evidence.time,
    session: ctx.session ?? null,
    teamId: ctx.teamId ?? null,
    kind: evidence.kind,
    subject: evidence.fingerprint,
    subjectName: nextEntry.profile.name,
    dim: evidence.dim,
    quality: evidence.quality,
    delta: Math.round(change.delta * 1e6) / 1e6,
    before: change.before,
    after: change.after,
    evidence: evidence.detail,
  }
  return {
    ledger: {
      ...ledger,
      updatedAt: Math.max(ledger.updatedAt ?? 0, evidence.time),
      agents: { ...ledger.agents, [evidence.fingerprint]: nextEntry },
    },
    auditRow,
    change,
  }
}

function normalizeProfile(profile) {
  return {
    name: String(profile?.name ?? ''),
    description: String(profile?.description ?? ''),
    provider: String(profile?.provider ?? ''),
    context: String(profile?.context ?? ''),
  }
}

function bumpStats(stats, evidence) {
  const s = { ...stats }
  switch (evidence.kind) {
    // task-completed emits TWO evidence records (competence + reliability);
    // count the task itself exactly once, on the competence record
    case 'task-completed':
      if (evidence.dim === 'competence') s.tasksCompleted = (s.tasksCompleted ?? 0) + 1
      break
    case 'tool-success': s.toolCalls = (s.toolCalls ?? 0) + 1; break
    case 'tool-error': s.toolCalls = (s.toolCalls ?? 0) + 1; s.toolErrors = (s.toolErrors ?? 0) + 1; break
    case 'message-sent': s.messagesSent = (s.messagesSent ?? 0) + 1; break
    case 'response-latency':
      if (evidence.quality >= 0.5) s.responsesOnTime = (s.responsesOnTime ?? 0) + 1
      else s.responsesLate = (s.responsesLate ?? 0) + 1
      break
    default: break
  }
  return s
}

/**
 * Replay audit rows into an equivalent ledger. Used by rebuild() and by
 * tests asserting projection/replay equivalence.
 * @param {Array<object>} auditRows parsed audit lines
 */
export function rebuildFromAudit(auditRows) {
  let ledger = freshLedger(0)
  for (const row of auditRows) {
    const evidence = {
      fingerprint: row.subject,
      dim: row.dim,
      quality: row.quality,
      kind: row.kind,
      profile: row.evidence?.profile,
      detail: row.evidence ?? {},
      time: row.time,
    }
    const applied = applyToLedger(ledger, evidence, { session: row.session, teamId: row.teamId })
    ledger = applied.ledger
  }
  return ledger
}

/** Read + parse all audit lines (missing file → empty array). */
export async function readAudit(dir = homeDir()) {
  const p = paths(dir)
  try {
    const raw = await readFile(p.audit, 'utf8')
    return raw.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
}

/**
 * One-shot rebuild: audit log → fresh ledger snapshot (in-place upgrade of
 * the projection). Kept as a maintenance entry point for the CLI/e2e.
 */
export async function rebuild(dir = homeDir()) {
  const release = await acquireLock(dir)
  try {
    const rows = await readAudit(dir)
    const ledger = rebuildFromAudit(rows)
    return await saveLedger(dir, ledger)
  } finally {
    await release()
  }
}

/** Dashboard projection over the whole ledger (pure). */
export function dashboard(ledger) {
  const agents = Object.values(ledger?.agents ?? {}).map((entry) => summarize(entry))
  agents.sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0))
  return { version: LEDGER_VERSION, updatedAt: ledger?.updatedAt ?? null, agents }
}

/** Content digest of a ledger snapshot — used by equivalence tests. */
export function ledgerDigest(ledger) {
  const relevant = {
    version: ledger.version,
    agents: Object.fromEntries(Object.entries(ledger.agents ?? {}).map(([fp, e]) => [fp, {
      profile: e.profile,
      trust: e.trust,
      stats: e.stats,
      history: e.history,
    }])),
  }
  return createHash('sha256').update(JSON.stringify(relevant)).digest('hex')
}

export { DIMENSIONS }
