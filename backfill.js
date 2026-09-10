/**
 * dsh-a2a-trust — backfill reader (SPEC 2.1 L0 bootstrap, SPEC 3.6 V2/V3).
 *
 * Scans session.jsonl.zstd logs under ~/.dsh/sessions (each workspace dir
 * holds per-session dirs; override with
 * DSH_SESSIONS_DIR), decompresses via system zstd, parses every line with
 * a V2/V3-tolerant reader, and feeds an Ingestor in (sessionId, event)
 * pairs. Session attribution uses the directory name (teammate dirs are
 * bare member UUIDs; Lead dirs are `session-<uuid>` — Ingestor.resolveMember
 * handles both by suffix matching).
 *
 * Envelope tolerance (V3 canonical envelopes, 2026-09-06 note):
 * - log-only events (team/*, agent/inbox/spliced, …) are
 *   {type, seq, time, data(, ignorable)} in BOTH generations — the trust
 *   substrate is migration-immune;
 * - user/message keeps data.source.kind === 'team-message' in both;
 * - tool/result error flag: data.error (V2-era) or message.content[0].isError
 *   (V3-guaranteed) — read by Ingestor.readToolError;
 * - V3 `surfaceOp` replace ranges: for the metrics we extract, only the
 *   final surface state matters; a replace event simply supersedes the
 *   earlier tool/result row, and since pairing is by callId the last
 *   result wins naturally.
 */

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'

import { Ingestor } from './ingest.js'
import { readAudit, saveLedger, acquireLock, appendAudit, rebuildFromAudit, applyToLedger, paths } from './storage.js'

/** Resolve the sessions root (env override wins — required by tests). */
export function sessionsDir(env = process.env) {
  if (typeof env.DSH_SESSIONS_DIR === 'string' && env.DSH_SESSIONS_DIR !== '') {
    return env.DSH_SESSIONS_DIR
  }
  return join(homedir(), '.dsh', 'sessions')
}

/**
 * Enumerate session directories containing a session log.
 * @returns {Promise<Array<{dir: string, sessionId: string, file: string, mtimeMs: number}>>}
 */
export async function scanSessions(root = sessionsDir()) {
  const out = []
  let workspaces
  try {
    workspaces = await readdir(root, { withFileTypes: true })
  } catch {
    return out // no sessions yet
  }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue
    let sessions
    try {
      sessions = await readdir(join(root, ws.name), { withFileTypes: true })
    } catch { continue }
    for (const s of sessions) {
      if (!s.isDirectory()) continue
      const file = join(root, ws.name, s.name, 'session.jsonl.zstd')
      try {
        const st = await stat(file)
        if (st.isFile()) out.push({ dir: join(root, ws.name, s.name), sessionId: s.name, file, mtimeMs: st.mtimeMs })
      } catch { /* no log in this dir */ }
    }
  }
  // mtime order is only the tie-break basis for the global event sort in
  // backfill() (and a deterministic scan order); it cannot express cross-
  // session causality on its own.
  out.sort((a, b) => a.mtimeMs - b.mtimeMs)
  return out
}

/**
 * Stream one .jsonl.zstd log through the line parser.
 * @yields {object} parsed event (null lines skipped)
 */
export async function* readSessionLog(file) {
  const child = execFile('zstd', ['-dc', file], { maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' })
  // execFile buffers whole output; for very large logs we accept the memory
  // cost (session logs are bounded by harness retention). Split on newline.
  const stdout = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.stdout.once('error', reject)
    let acc = ''
    child.stdout.on('data', (c) => { acc += c })
    child.stdout.once('end', () => resolve(acc))
    child.once('exit', (code, signal) => {
      if (code !== 0 && signal === null && acc === '') {
        reject(new Error(`zstd exited ${code} for ${file}`))
      }
    })
  })
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      yield JSON.parse(trimmed)
    } catch { /* skip malformed line */ }
  }
}

/**
 * Full backfill: scan → replay → ledger + audit append.
 *
 * Idempotency: the caller passes `sinceAuditRows` (usually the current
 * audit length) — already-audited history is NOT re-appended; the ingest
 * phase is deterministic, so replaying only the suffix keeps audit and
 * ledger consistent across repeated runs.
 *
 * @param {object} opts {sessionsDir, trustDir, onProgress(session, events)}
 * @returns {{sessions: number, events: number, evidence: number, agents: number}}
 */
export async function backfill(opts = {}) {
  const sessionsRoot = opts.sessionsDir ?? sessionsDir()
  const trustDir = opts.trustDir ?? undefined // storage.homeDir default
  const sessions = await scanSessions(sessionsRoot)

  const ingestor = new Ingestor()
  let events = 0
  const evidenceAll = []
  // Global chronological replay. Per-session mtime ordering cannot express
  // causality: a Lead session log spans the whole team run, so its mtime is
  // the LATEST while its team/member roster events causally precede every
  // teammate event — replaying sessions by mtime order loses all teammate
  // attribution. Sorting every parsed event by its own timestamp restores
  // the causal order (a stable sort keeps session-scan order on ties).
  const timed = []
  for (const s of sessions) {
    let count = 0
    for await (const event of readSessionLog(s.file)) {
      count += 1
      timed.push({ session: s.sessionId, event, time: typeof event.time === 'number' ? event.time : 0 })
    }
    events += count
    if (opts.onProgress) opts.onProgress(s.sessionId, count)
  }
  timed.sort((a, b) => a.time - b.time)
  for (const { session, event } of timed) {
    for (const evidence of ingestor.feed(session, event)) {
      evidenceAll.push({ ...evidence, session })
    }
  }

  // Persist: audit-first, one canonical applyToLedger pass per fresh
  // evidence record so audit rows and the ledger stay in lockstep.
  const release = await acquireLock(trustDir ?? undefined)
  try {
    const existing = await readAudit(trustDir ?? undefined)
    const seenSessions = new Set(existing.map((r) => r.session).filter(Boolean))
    const fresh = evidenceAll.filter((e) => !seenSessions.has(e.session))
    let ledger = rebuildFromAudit(existing)
    for (const e of fresh) {
      const applied = applyToLedger(ledger, e, { session: e.session })
      await appendAudit(trustDir ?? undefined, applied.auditRow)
      ledger = applied.ledger
    }
    await saveLedger(trustDir ?? undefined, ledger)
    return {
      sessions: sessions.length,
      events,
      evidence: fresh.length,
      agents: Object.keys(ledger.agents ?? {}).length,
    }
  } finally {
    await release()
  }
}

export { paths }
