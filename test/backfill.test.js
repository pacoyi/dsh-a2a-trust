/**
 * backfill.js integration tests — full scan → decompress → replay →
 * persist cycle against a synthetic sessions tree with real zstd logs,
 * plus idempotency (second run appends nothing new).
 *
 * Skips gracefully when the system zstd binary is unavailable.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { scanSessions, backfill, readSessionLog } from '../backfill.js'
import { loadLedger, readAudit } from '../storage.js'
import { fingerprint } from '../trust.js'

const exec = promisify(execFile)

let haveZstd = true
try { await exec('zstd', ['--version']) } catch { haveZstd = false }

let sessionsRoot
let trustDir
let wsDir

const WORKER_A = { name: 'worker-a', description: 'subtask A', provider: 'spawn', context: 'fresh' }
const FP_A = fingerprint(WORKER_A)

const lines = [
  JSON.stringify({ type: 'team/member', seq: 1, time: 1000, data: { version: 2, teamId: 'session-lead-1', member: { id: 'uuid-aaa', ...WORKER_A, phase: 'active' } } }),
  JSON.stringify({ type: 'team/task', seq: 2, time: 2000, data: { version: 2, teamId: 'session-lead-1', task: { id: 't1', revision: 1, subject: 's', description: '', status: 'pending', ownerId: 'uuid-aaa', blockedBy: [], writeScopes: [] } } }),
  JSON.stringify({ type: 'team/task', seq: 3, time: 3000, data: { version: 2, teamId: 'session-lead-1', task: { id: 't1', revision: 2, subject: 's', description: '', status: 'completed', ownerId: 'uuid-aaa', blockedBy: [], writeScopes: [] } } }),
]

// Worker's OWN session log (bare-UUID directory, mirroring real teammate
// sessions) — tool calls execute here, not on the Lead log.
const workerLines = [
  JSON.stringify({ type: 'tool/call', seq: 4, time: 4000, data: { turn: 1, step: 1, callId: 'call-1', name: 'read_file', arguments: '{}' } }),
  // V3 spelling: surfaceOp + sourceEventSeqs present
  JSON.stringify({ type: 'tool/result', seq: 5, time: 4500, surfaceOp: 'append', sourceEventSeqs: [4], data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', isError: false }] } } }),
]

async function makeSession(root, ws, sessionName, jsonlLines) {
  const dir = join(root, ws, sessionName)
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'session.jsonl.zstd')
  // async execFile has no `input` option — write stdin manually
  await new Promise((resolve, reject) => {
    const child = execFile('zstd', ['-q', '-f', '-o', file])
    child.stdin.on('error', reject)
    child.once('error', reject)
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`zstd exited ${code}`))))
    child.stdin.end(jsonlLines.join('\n') + '\n')
  })
  return file
}

before(async () => {
  sessionsRoot = await mkdtemp(join(tmpdir(), 'a2a-sessions-'))
  trustDir = await mkdtemp(join(tmpdir(), 'a2a-trustdir-'))
  wsDir = 'ws-test'
})

after(async () => {
  await rm(sessionsRoot, { recursive: true, force: true })
  await rm(trustDir, { recursive: true, force: true })
})

describe('backfill (requires zstd)', { skip: !haveZstd }, () => {
  test('scanSessions finds the sessions with logs', async () => {
    await makeSession(sessionsRoot, wsDir, 'session-lead-1', lines)
    await makeSession(sessionsRoot, wsDir, 'uuid-aaa', workerLines)
    // an empty dir without a log must be ignored
    await mkdir(join(sessionsRoot, wsDir, 'no-log-dir'), { recursive: true })
    const found = await scanSessions(sessionsRoot)
    assert.equal(found.length, 2)
    const names = found.map((f) => f.sessionId).sort()
    assert.deepEqual(names, ['session-lead-1', 'uuid-aaa'])
  })

  test('readSessionLog decompresses and parses every line', async () => {
    const found = await scanSessions(sessionsRoot)
    const lead = found.find((f) => f.sessionId === 'session-lead-1')
    const events = []
    for await (const e of readSessionLog(lead.file)) events.push(e)
    assert.equal(events.length, lines.length)
    assert.equal(events[0].type, 'team/member')
  })

  test('backfill produces a ledger with the worker fingerprint', async () => {
    const result = await backfill({ sessionsDir: sessionsRoot, trustDir })
    assert.equal(result.sessions, 2)
    assert.equal(result.events, lines.length + workerLines.length)
    assert.equal(result.evidence, 4) // member-registered + task-completed×2 dims + tool-success
    assert.equal(result.agents, 1)
    const ledger = await loadLedger(trustDir)
    const entry = ledger.agents[FP_A]
    assert.equal(entry.profile.name, 'worker-a')
    assert.equal(entry.trust.competence.samples, 2) // task-completed + tool-success
    assert.equal(entry.trust.reliability.samples, 1)
    assert.equal(entry.stats.tasksCompleted, 1)
    assert.equal(entry.stats.toolCalls, 1)
    // audit rows carry the session that produced each evidence
    const rows = await readAudit(trustDir)
    assert.equal(rows.length, 4)
    assert.equal(rows.some((r) => r.kind === 'member-registered'), true)
    const toolRow = rows.find((r) => r.kind === 'tool-success')
    assert.equal(toolRow.session, 'uuid-aaa') // attributed to the worker session
  })

  test('second backfill is a no-op (idempotent by session)', async () => {
    const again = await backfill({ sessionsDir: sessionsRoot, trustDir })
    assert.equal(again.evidence, 0) // session already audited
    const rows = await readAudit(trustDir)
    assert.equal(rows.length, 4) // unchanged
    const ledger = await loadLedger(trustDir)
    assert.equal(ledger.agents[FP_A].trust.competence.samples, 2) // unchanged
  })

  test('new session appended incrementally', async () => {
    const more = [
      JSON.stringify({ type: 'team/member', seq: 1, time: 9000, data: { version: 2, teamId: 'session-lead-2', member: { id: 'uuid-bbb', ...WORKER_A, phase: 'active' } } }),
      JSON.stringify({ type: 'team/task', seq: 2, time: 9500, data: { version: 2, teamId: 'session-lead-2', task: { id: 't9', revision: 1, subject: 's', description: '', status: 'pending', ownerId: 'uuid-bbb', blockedBy: [], writeScopes: [] } } }),
      JSON.stringify({ type: 'team/task', seq: 3, time: 9900, data: { version: 2, teamId: 'session-lead-2', task: { id: 't9', revision: 2, subject: 's', description: '', status: 'completed', ownerId: 'uuid-bbb', blockedBy: [], writeScopes: [] } } }),
    ]
    await makeSession(sessionsRoot, wsDir, 'session-lead-2', more)
    const result = await backfill({ sessionsDir: sessionsRoot, trustDir })
    assert.equal(result.evidence, 3) // member-registered + task-completed×2 dims
    const ledger = await loadLedger(trustDir)
    assert.equal(ledger.agents[FP_A].trust.competence.samples, 3) // cross-session accumulation!
    assert.equal(ledger.agents[FP_A].stats.tasksCompleted, 2)
  })

  test('empty sessions root is a clean no-op', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'a2a-empty-'))
    try {
      const result = await backfill({ sessionsDir: empty, trustDir })
      assert.equal(result.sessions, 0)
      assert.equal(result.evidence, 0)
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })

  test('teammate attribution survives reverse-mtime replay (real-world shape)', async () => {
    // Regression: a Lead session log spans the whole team run, so its mtime
    // is the LATEST — per-session mtime replay registered the roster only
    // after every teammate tool event and lost all attribution. Only the
    // global event-time sort restores causality.
    const lead = [
      JSON.stringify({ type: 'team/member', seq: 1, time: 1000, data: { version: 2, teamId: 'session-lead-3', member: { id: 'uuid-ccc', ...WORKER_A, phase: 'active' } } }),
      JSON.stringify({ type: 'team/task', seq: 2, time: 2000, data: { version: 2, teamId: 'session-lead-3', task: { id: 't3', revision: 1, subject: 's', description: '', status: 'pending', ownerId: 'uuid-ccc', blockedBy: [], writeScopes: [] } } }),
      JSON.stringify({ type: 'team/task', seq: 3, time: 9000, data: { version: 2, teamId: 'session-lead-3', task: { id: 't3', revision: 2, subject: 's', description: '', status: 'completed', ownerId: 'uuid-ccc', blockedBy: [], writeScopes: [] } } }),
    ]
    const worker = [
      JSON.stringify({ type: 'tool/call', seq: 1, time: 3000, data: { turn: 1, step: 1, callId: 'call-3', name: 'read_file', arguments: '{}' } }),
      JSON.stringify({ type: 'tool/result', seq: 2, time: 3500, data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'call-3' }, content: [{ type: 'tool-result', isError: false }] } } }),
    ]
    // real-world mtimes: the worker log finishes FIRST, the Lead log LAST
    const reverseRoot = await mkdtemp(join(tmpdir(), 'a2a-sessions-reverse-'))
    const leadFile = await makeSession(reverseRoot, wsDir, 'session-lead-3', lead)
    const workerFile = await makeSession(reverseRoot, wsDir, 'uuid-ccc', worker)
    const { utimes } = await import('node:fs/promises')
    await utimes(workerFile, new Date(1000), new Date(1000)) // worker mtime: earliest
    await utimes(leadFile, new Date(99_000), new Date(99_000)) // lead mtime: latest

    const freshTrust = await mkdtemp(join(tmpdir(), 'a2a-trustdir-reverse-'))
    try {
      const result = await backfill({ sessionsDir: reverseRoot, trustDir: freshTrust })
      // this fixture adds: member-registered + task-completed×2 dims + tool-success
      assert.equal(result.evidence, 4)
      const rows = await readAudit(freshTrust)
      const toolRow = rows.find((r) => r.kind === 'tool-success')
      assert.ok(toolRow, 'worker tool evidence attributed despite reverse mtimes')
      assert.equal(toolRow.subjectName, 'worker-a')
      const ledger = await loadLedger(freshTrust)
      assert.equal(ledger.agents[FP_A].stats.toolCalls, 1)
      assert.equal(ledger.agents[FP_A].trust.competence.samples, 2) // task + tool
    } finally {
      await rm(freshTrust, { recursive: true, force: true })
      await rm(reverseRoot, { recursive: true, force: true })
    }
  })

  test('missing sessions root does not throw', async () => {
    const result = await backfill({ sessionsDir: join(sessionsRoot, 'does-not-exist'), trustDir })
    assert.equal(result.sessions, 0)
  })
})

describe('makeSession helper sanity', { skip: !haveZstd }, () => {
  test('zstd file is genuinely compressed (magic bytes)', async () => {
    const found = await scanSessions(sessionsRoot)
    const { readFile } = await import('node:fs/promises')
    const buf = await readFile(found[0].file)
    // zstd magic 28 B5 2F FD
    assert.equal(buf[0], 0x28)
    assert.equal(buf[1], 0xb5)
  })
})
