/**
 * storage.js contract tests — audit-first discipline, crash safety, lock
 * takeover, and audit→ledger replay equivalence.
 *
 * Crash injection: we simulate the two-phase write failing between audit
 * append and snapshot save by corrupting/deleting the snapshot, then assert
 * rebuild() recovers every change from the audit log.
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  paths, homeDir, loadLedger, saveLedger, appendAudit, readAudit,
  applyToLedger, rebuildFromAudit, rebuild, acquireLock, dashboard, ledgerDigest,
} from '../storage.js'
import { createAgentEntry, fingerprint } from '../trust.js'

let dir
let seq = 0

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), `a2a-trust-${++seq}-`))
})

const PROFILE = { name: 'worker-a', description: 'subtask A worker', provider: 'spawn', context: 'fresh' }
const FP = fingerprint(PROFILE)

const evidence = (dim, quality, kind, time) => ({
  fingerprint: FP, dim, quality, kind, detail: { taskId: 't1' }, time,
})

describe('homeDir resolution', () => {
  test('env override wins', () => {
    assert.equal(homeDir({ A2A_TRUST_HOME: '/tmp/x' }), '/tmp/x')
  })
  test('default lands under ~/.dsh', () => {
    assert.match(homeDir({}), /dsh-a2a-trust$/)
  })
})

describe('audit-first mutation path', () => {
  test('applyToLedger creates the agent entry on first evidence', () => {
    let ledger = { version: 1, updatedAt: 0, agents: {} }
    const { ledger: next, auditRow } = applyToLedger(ledger, evidence('competence', 1.0, 'tool-success', 1000))
    assert.equal(next.agents[FP].trust.competence.value, 0.55)
    assert.equal(auditRow.subject, FP)
    assert.equal(auditRow.dim, 'competence')
    assert.equal(auditRow.after, 0.55)
    assert.equal(auditRow.before, 0.5)
  })

  test('audit row lands before the snapshot on disk', async () => {
    let ledger = { version: 1, updatedAt: 0, agents: {} }
    const applied = applyToLedger(ledger, evidence('competence', 1.0, 'tool-success', 1000))
    await appendAudit(dir, applied.auditRow)
    await saveLedger(dir, applied.ledger)
    const rows = await readAudit(dir)
    assert.equal(rows.length, 1)
    const loaded = await loadLedger(dir)
    assert.equal(loaded.agents[FP].trust.competence.value, 0.55)
  })

  test('ledger.json write is atomic (tmp + rename, prior kept as .bak)', async () => {
    const l1 = { version: 1, updatedAt: 1, agents: { [FP]: createAgentEntry(PROFILE, 1) } }
    await saveLedger(dir, l1)
    const l2 = { ...l1, updatedAt: 2 }
    await saveLedger(dir, l2)
    const p = paths(dir)
    assert.equal((await readdir(dir)).includes('ledger.json.bak'), true)
    assert.equal(JSON.parse(await readFile(p.ledger, 'utf8')).updatedAt, 2)
    // no tmp residue
    assert.equal((await readdir(dir)).filter((f) => f.startsWith('ledger.json.tmp')).length, 0)
  })

  test('corrupt ledger falls back to .bak', async () => {
    await saveLedger(dir, { version: 1, updatedAt: 1, agents: { [FP]: createAgentEntry(PROFILE, 1) } })
    await saveLedger(dir, { version: 1, updatedAt: 2, agents: {} })
    // corrupt the current snapshot
    await writeFile(paths(dir).ledger, '{ broken json', 'utf8')
    const loaded = await loadLedger(dir)
    assert.equal(loaded.updatedAt, 1) // recovered from bak
    assert.equal(loaded.agents[FP] !== undefined, true)
  })

  test('missing store starts fresh', async () => {
    const loaded = await loadLedger(dir)
    assert.deepEqual(loaded.agents, {})
  })
})

describe('crash injection: audit survives, snapshot stales', () => {
  test('rebuild() recovers every audited change after snapshot loss', async () => {
    // run 5 mutations through the audit-first path
    for (let i = 0; i < 5; i++) {
      let ledger = await loadLedger(dir)
      const applied = applyToLedger(ledger, evidence('competence', 1.0, 'tool-success', 1000 + i))
      await appendAudit(dir, applied.auditRow)
      if (i < 4) await saveLedger(dir, applied.ledger) // crash before the last save
    }
    // snapshot is stale by one change; rebuild closes the gap
    const rebuilt = await rebuild(dir)
    assert.equal(rebuilt.agents[FP].trust.competence.samples, 5)
    // EWMA after 5 good steps from 0.5
    let expect = 0.5
    for (let i = 0; i < 5; i++) expect = 0.1 * 1 + 0.9 * expect
    assert.equal(rebuilt.agents[FP].trust.competence.value, Math.round(expect * 1e6) / 1e6)
  })

  test('total snapshot loss: audit alone rebuilds everything', async () => {
    let ledger = { version: 1, updatedAt: 0, agents: {} }
    const kinds = ['tool-success', 'tool-error', 'task-completed', 'message-sent']
    for (let i = 0; i < kinds.length; i++) {
      const applied = applyToLedger(ledger, evidence('competence', i % 2 ? 0 : 1, kinds[i], 1000 + i))
      await appendAudit(dir, applied.auditRow)
      ledger = applied.ledger
    }
    await rm(paths(dir).ledger, { force: true })
    await rm(paths(dir).ledgerBak, { force: true })
    const rebuilt = await rebuild(dir)
    assert.equal(rebuilt.agents[FP].trust.competence.samples, 4)
    assert.equal(rebuilt.agents[FP].stats.toolCalls, 2) // success + error
    assert.equal(rebuilt.agents[FP].stats.toolErrors, 1)
    assert.equal(rebuilt.agents[FP].stats.tasksCompleted, 1)
    assert.equal(rebuilt.agents[FP].stats.messagesSent, 1)
  })

  test('replay equivalence: live-mutated ledger ≡ rebuilt-from-audit ledger', async () => {
    // live path — starts with a profile registration (trust-neutral)
    let live = { version: 1, updatedAt: 0, agents: {} }
    const stream = [
      { fingerprint: FP, dim: null, quality: null, kind: 'member-registered', profile: PROFILE, detail: {}, time: 500 },
      evidence('competence', 1.0, 'tool-success', 1000),
      evidence('competence', 0.0, 'tool-error', 2000),
      evidence('reliability', 1.0, 'task-completed', 3000),
      evidence('communication', 0.7, 'message-sent', 4000),
      evidence('communication', 0.0, 'response-latency', 5000),
    ]
    for (const e of stream) {
      const applied = applyToLedger(live, e, { session: 's1', teamId: 't1' })
      await appendAudit(dir, applied.auditRow)
      live = applied.ledger
    }
    assert.equal(live.agents[FP].profile.name, 'worker-a') // profile flowed in
    const rows = await readAudit(dir)
    const rebuilt = rebuildFromAudit(rows)
    assert.equal(ledgerDigest(live), ledgerDigest(rebuilt))
  })
})

describe('cross-process lock', () => {
  test('acquireLock creates a missing store directory (first-ever run)', async () => {
    // Regression: on a fresh machine the store dir does not exist and the
    // non-recursive lock mkdir died with ENOENT — only the real-environment
    // e2e caught it, because every other test pre-creates its tmp dir.
    const fresh = join(tmpdir(), `a2a-fresh-${process.pid}-${Date.now()}`)
    const release = await acquireLock(fresh, { waitMs: 200 })
    await release()
    const p = paths(fresh)
    assert.equal((await readdir(fresh)).includes('.ledger.lock'), false, 'lock cleaned up after release')
    await rm(fresh, { recursive: true, force: true })
  })

  test('acquire + release + re-acquire works', async () => {
    const release = await acquireLock(dir)
    await release()
    const release2 = await acquireLock(dir)
    await release2()
  })

  test('second acquisition within wait budget fails loudly', async () => {
    const r1 = await acquireLock(dir, { waitMs: 100 })
    await assert.rejects(() => acquireLock(dir, { waitMs: 120 }), /busy/)
    await r1()
  })

  test('dead-owner lock is taken over', async () => {
    const p = paths(dir)
    await mkdir(p.lockDir, { recursive: true })
    // a PID that is guaranteed dead on this machine (pid 4000000 is out of range)
    await writeFile(p.ownerFile, JSON.stringify({ pid: 4000000, ts: Date.now() }), 'utf8')
    const release = await acquireLock(dir, { waitMs: 500 })
    await release()
  })

  test('live-owner young lock is NOT taken over', async () => {
    const p = paths(dir)
    await mkdir(p.lockDir, { recursive: true })
    await writeFile(p.ownerFile, JSON.stringify({ pid: process.pid, ts: Date.now() }), 'utf8')
    await assert.rejects(() => acquireLock(dir, { waitMs: 100 }), /busy/)
    await rm(p.lockDir, { recursive: true, force: true })
  })
})

describe('dashboard projection', () => {
  test('agents sorted by lastSeen with confidence flags and real profiles', async () => {
    let ledger = { version: 1, updatedAt: 0, agents: {} }
    const profB = { name: 'worker-b', description: 'b', provider: 'spawn', context: 'fresh' }
    // register both agent types first (profile flow), then apply evidence
    const regA = applyToLedger(ledger, { fingerprint: FP, dim: null, quality: null, kind: 'member-registered', profile: PROFILE, detail: {}, time: 100 })
    ledger = regA.ledger
    const regB = applyToLedger(ledger, { fingerprint: fingerprint(profB), dim: null, quality: null, kind: 'member-registered', profile: profB, detail: {}, time: 200 })
    ledger = regB.ledger
    const appliedB = applyToLedger(ledger, { fingerprint: fingerprint(profB), dim: 'competence', quality: 1, kind: 'tool-success', detail: {}, time: 9000 })
    ledger = appliedB.ledger
    const appliedA = applyToLedger(ledger, evidence('competence', 1, 'tool-success', 1000))
    const board = dashboard(appliedA.ledger)
    assert.equal(board.agents.length, 2)
    assert.equal(board.agents[0].profile.name, 'worker-b') // lastSeen 9000 > 1000
    assert.equal(board.agents[1].profile.name, 'worker-a')
    assert.equal(board.agents.every((a) => a.dims !== undefined), true)
  })
})
