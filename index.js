/**
 * dsh-a2a-trust — host half (L0 observer).
 *
 * Live ingestion over `ctx.on('session/event')` (same pattern as the
 * agent-team mailbox observer), audit-first persistence, a startup
 * backfill bootstrap over historical session logs (idempotent by session),
 * and a loopback RPC surface for the Settings dashboard.
 *
 * Philosophy: information-injecting governance only. Nothing here blocks,
 * rewrites, or filters agent-to-agent traffic — trust is a signal, not a
 * constraint (SPEC 2.0).
 */

import { homeDir, loadLedger, saveLedger, appendAudit, applyToLedger, acquireLock, dashboard, paths } from './storage.js'
import { Ingestor } from './ingest.js'
import { backfill } from './backfill.js'
import { totalScore, LOW_CONFIDENCE_SAMPLES } from './trust.js'

export const name = 'dsh-a2a-trust'
export const inject = []

/** Log a one-line summary when a trust step moves more than this. */
const NOTABLE_DELTA = 0.05

export function apply(ctx) {
  const dir = homeDir()
  const log = ctx?.logger ?? console
  const ingestor = new Ingestor()
  let tail = Promise.resolve() // serialized persistence tail

  async function persist(evidence, session) {
    // Cross-process ledger lock: the read-modify-write must be atomic.
    // Without it, the startup backfill (or a second profile service)
    // holding the same lock rebuilds from an older audit prefix and its
    // snapshot silently reverts live updates — the lost-update race the
    // plugin integration tests catch intermittently.
    const release = await acquireLock(dir, { waitMs: 30_000 })
    try {
      // audit-first: append the row before refreshing the snapshot (SPEC 3.5)
      let ledger = await loadLedger(dir)
      const applied = applyToLedger(ledger, evidence, { session })
      await appendAudit(dir, applied.auditRow)
      await saveLedger(dir, applied.ledger)
      return applied
    } finally {
      await release()
    }
  }

  function ingest(sessionId, event) {
    let batch
    try {
      batch = ingestor.feed(sessionId, event)
    } catch (error) {
      log.warn?.(`a2a-trust: ingest failed: ${errorMessage(error)}`)
      return
    }
    for (const evidence of batch) {
      tail = tail
        .then(() => persist(evidence, sessionId))
        .then((applied) => {
          const delta = Math.abs(applied.change?.delta ?? 0)
          if (delta >= NOTABLE_DELTA) {
            log.info?.(`a2a-trust: ${applied.auditRow.subjectName || evidence.fingerprint.slice(0, 8)} ` +
              `${evidence.dim} ${applied.change.before.toFixed(3)} → ${applied.change.after.toFixed(3)} ` +
              `(${evidence.kind})`)
          }
        })
        .catch((error) => {
          log.warn?.(`a2a-trust: persistence failed: ${errorMessage(error)}`)
        })
    }
  }

  ctx.on('session/event', (session, event) => {
    ingest(session?.id ?? null, event)
  })

  // Startup bootstrap: replay historical session logs once (idempotent by
  // session — repeated restarts only ingest what was never audited).
  if (ctx.effect) {
    ctx.effect(async () => {
      try {
        const result = await backfill({ trustDir: dir })
        if (result.evidence > 0) {
          log.info?.(`a2a-trust: backfill ${result.evidence} evidence from ${result.sessions} session(s), ` +
            `${result.agents} agent type(s) tracked`)
        }
      } catch (error) {
        log.warn?.(`a2a-trust: backfill skipped: ${errorMessage(error)}`)
      }
      return () => { /* live tail keeps running until process exit */ }
    }, 'a2aTrust.startup()')
  }

  // Dashboard RPC (loopback-only channel; browser half calls /a2a-trust).
  // rc.7 contract: handlers MUST resolve to an envelope {ok, value} /
  // {ok, error} — a bare object fails the connection bridge's response
  // validation and surfaces client-side as "invalid server-response result".
  ctx.inject?.(['connection'], (connectionCtx) => {
    const connection = connectionCtx.connection
    if (connection === undefined || connection.rpc === undefined || typeof connection.rpc.handle !== 'function') return
    connection.rpc.handle('/a2a-trust', async (endpoint, payload) => {
      if (endpoint !== 'dashboard') {
        return { ok: false, error: { code: 'bad-request', message: `a2a-trust: unknown endpoint: ${endpoint}`, details: { issues: [] } } }
      }
      void payload
      try {
        await tail // settle in-flight mutations first
        const ledger = await loadLedger(dir)
        return { ok: true, value: dashboard(ledger) }
      } catch (error) {
        return { ok: false, error: { code: 'internal', message: errorMessage(error), details: { issues: [] } } }
      }
    }, { authority: 'loopback' })
  })
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Test/CLI helper: current dashboard snapshot for a store directory. */
export async function snapshot(storeDir = homeDir()) {
  const ledger = await loadLedger(storeDir)
  return dashboard(ledger)
}

export { paths, totalScore, LOW_CONFIDENCE_SAMPLES, backfill, Ingestor }
