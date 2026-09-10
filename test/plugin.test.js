/**
 * index.js integration tests — the real apply() wired into a mocked Cordis
 * context: live session/event ingestion lands in ledger+audit, notable
 * changes are logged, the RPC dashboard endpoint reflects state, the
 * handler survives garbage events, and the L1 advisor registers its
 * PromptContext seam through the injected services.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, snapshot } from '../index.js'
import { loadLedger, readAudit } from '../storage.js'
import { fingerprint } from '../trust.js'

const exec = promisify(execFile)

let haveZstd = true
try { await exec('zstd', ['--version']) } catch { haveZstd = false }

let dir
let sessionsRoot
let handlers
let rpcHandler
let infos
let warns

// cordis-like inject: the callback fires only when every declared service
// is present in scope (connection is always available for the RPC surface;
// agentTeams / systemPrompt come from the test's services argument).
function mockContext(services = {}) {
  handlers = {}
  infos = []
  warns = []
  return {
    on: (event, handler) => { handlers[event] = handler },
    effect: (fn) => { fn().catch(() => {}) }, // startup backfill is tested separately
    inject: (deps, cb) => {
      const scope = {}
      for (const dep of deps) {
        if (dep === 'connection') {
          scope.connection = { rpc: { handle: (_channel, fn) => { rpcHandler = fn } } }
        } else if (services[dep] !== undefined) {
          scope[dep] = services[dep]
        }
      }
      if (deps.every((dep) => scope[dep] !== undefined)) cb(scope)
    },
    logger: {
      info: (msg) => { infos.push(msg) },
      warn: (msg) => { warns.push(msg) },
    },
  }
}

const WORKER_A = { name: 'worker-a', description: 'subtask A', provider: 'spawn', context: 'fresh' }
const FP_A = fingerprint(WORKER_A)
const LEAD = 'session-lead-1'

function feed(sessionId, event) {
  handlers['session/event']({ id: sessionId }, event)
}

// Wait (bounded) for the serialized persistence tail to satisfy `check`
// against the LEDGER — polling audit-row counts is not enough: persist()
// appends the audit row BEFORE saving the snapshot, so audit can reach N
// while the ledger still reflects N-1 (the exact crash window the
// audit-first design survives). A fixed sleep flakes under parallel load.
async function settleLedger(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  let ledger = {}
  for (;;) {
    ledger = await loadLedger(dir)
    if (check(ledger) || Date.now() > deadline) return ledger
    await new Promise((r) => setTimeout(r, 20))
  }
}

function memberEvent(memberId, time) {
  return { type: 'team/member', seq: 1, time, data: { version: 2, teamId: LEAD, member: { id: memberId, ...WORKER_A, phase: 'active' } } }
}

function taskEvent(taskId, status, ownerId, revision, time) {
  return { type: 'team/task', seq: 2, time, data: { version: 2, teamId: LEAD, task: { id: taskId, revision, subject: 's', description: '', status, ownerId, blockedBy: [], writeScopes: [] } } }
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'a2a-plugin-'))
  sessionsRoot = await mkdtemp(join(tmpdir(), 'a2a-plugin-sessions-'))
  process.env.A2A_TRUST_HOME = dir
  process.env.DSH_SESSIONS_DIR = sessionsRoot
  apply(mockContext())
})

after(async () => {
  delete process.env.A2A_TRUST_HOME
  delete process.env.DSH_SESSIONS_DIR
  await rm(dir, { recursive: true, force: true })
  await rm(sessionsRoot, { recursive: true, force: true })
})

describe('live ingestion through apply()', () => {
  test('member + task events land in ledger and audit', async () => {
    feed(LEAD, memberEvent('uuid-aaa', 1000))
    feed(LEAD, taskEvent('t1', 'pending', 'uuid-aaa', 1, 2000))
    feed(LEAD, taskEvent('t1', 'completed', 'uuid-aaa', 2, 3000))
    // let the serialized tail settle
    await settleLedger((l) => l.agents[FP_A]?.profile?.name === 'worker-a'
      && l.agents[FP_A]?.stats?.tasksCompleted === 1)
    const ledger = await loadLedger(dir)
    const entry = ledger.agents[FP_A]
    assert.equal(entry.profile.name, 'worker-a')
    assert.equal(entry.trust.competence.samples, 1)
    assert.equal(entry.stats.tasksCompleted, 1)
    const rows = await readAudit(dir)
    assert.equal(rows.length, 3) // member-registered + 2 dims of task-completed
  })

  test('notable bad-evidence step is logged', async () => {
    feed('uuid-aaa', { type: 'tool/call', seq: 3, time: 4000, data: { turn: 1, step: 1, callId: 'c1', name: 'x', arguments: '{}' } })
    feed('uuid-aaa', {
      type: 'tool/result', seq: 4, time: 4100,
      data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', isError: true }] } },
    })
    await settleLedger((l) => l.agents[FP_A]?.trust?.competence?.samples === 2)
    assert.equal(infos.some((m) => m.includes('competence') && m.includes('tool-error')), true)
  })

  test('garbage events never crash the handler', () => {
    feed(LEAD, null)
    feed(LEAD, {})
    feed(LEAD, { type: 42 })
    feed(null, memberEvent('uuid-zzz', 5000))
    // handler still alive
    assert.equal(typeof handlers['session/event'], 'function')
  })

  test('RPC dashboard endpoint returns the rc.7 envelope with the projection', async () => {
    assert.equal(typeof rpcHandler, 'function')
    const res = await rpcHandler('dashboard', {})
    // connection bridge contract: {ok, value} envelope, never a bare object
    // (a bare object fails response validation client-side)
    assert.equal(res.ok, true)
    assert.equal(res.value.agents.length, 1)
    assert.equal(res.value.agents[0].profile.name, 'worker-a')
    assert.equal(res.value.agents[0].stats.tasksCompleted, 1)
  })

  test('RPC unknown endpoint resolves to an ok:false envelope', async () => {
    const res = await rpcHandler('bogus', {})
    assert.equal(res.ok, false)
    assert.equal(res.error.code, 'bad-request')
    assert.match(res.error.message, /unknown endpoint/)
  })

  test('snapshot helper reads the same state', async () => {
    const snap = await snapshot(dir)
    assert.equal(snap.agents.length, 1)
  })
})

describe('startup backfill via ctx.effect', () => {
  test('effect-triggered backfill ingests a historical session once', async () => {
    const lines = [
      JSON.stringify({ type: 'team/member', seq: 1, time: 9000, data: { version: 2, teamId: 'session-lead-2', member: { id: 'uuid-bbb', ...WORKER_A, phase: 'active' } } }),
      JSON.stringify({ type: 'team/task', seq: 2, time: 9500, data: { version: 2, teamId: 'session-lead-2', task: { id: 't9', revision: 1, subject: 's', description: '', status: 'pending', ownerId: 'uuid-bbb', blockedBy: [], writeScopes: [] } } }),
      JSON.stringify({ type: 'team/task', seq: 3, time: 9900, data: { version: 2, teamId: 'session-lead-2', task: { id: 't9', revision: 2, subject: 's', description: '', status: 'completed', ownerId: 'uuid-bbb', blockedBy: [], writeScopes: [] } } }),
    ]
    // write a zstd-compressed historical log
    const sessDir = join(sessionsRoot, 'ws', 'session-lead-2')
    await mkdir(sessDir, { recursive: true })
    const file = join(sessDir, 'session.jsonl.zstd')
    await new Promise((resolve, reject) => {
      const child = execFile('zstd', ['-q', '-f', '-o', file])
      child.stdin.on('error', reject)
      child.once('error', reject)
      child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`zstd exited ${code}`))))
      child.stdin.end(lines.join('\n') + '\n')
    })
    // drive a fresh apply() whose ctx.effect runs the startup backfill
    const effectHandlers = []
    const ctx = {
      on: () => {},
      effect: (fn) => { effectHandlers.push(fn) },
      inject: () => {},
      logger: { info: (m) => infos.push(m), warn: (m) => warns.push(m) },
    }
    apply(ctx)
    await effectHandlers[0]()
    const ledger = await loadLedger(dir)
    assert.equal(ledger.agents[FP_A].stats.tasksCompleted, 2) // live 1 + backfill 1
    assert.equal(ledger.agents[FP_A].trust.competence.samples, 3) // live 1 + backfill 1 + tool-error 1
    assert.equal(infos.some((m) => m.includes('backfill')), true)
    // re-running the effect (service restart) changes nothing
    const rowsBefore = (await readAudit(dir)).length
    await effectHandlers[0]()
    const rowsAfter = (await readAudit(dir)).length
    assert.equal(rowsAfter, rowsBefore)
  })
})

describe('backfill skip when zstd is missing', { skip: haveZstd }, () => {
  test('effect failure is a warning, not a crash', async () => {
    const effectHandlers = []
    apply({
      on: () => {},
      effect: (fn) => { effectHandlers.push(fn) },
      inject: () => {},
      logger: { info: () => {}, warn: (m) => warns.push(m) },
    })
    await effectHandlers[0]()
    assert.equal(warns.some((m) => m.includes('backfill skipped')), true)
  })
})

// ── L1 advisor: PromptContext seam ─────────────────────────────────────────

describe('L1 advisor injection (PromptContext seam)', () => {
  // Live agent stand-ins matched by reference in agentTeams.membership.
  const leadAgent = { id: 'agent-lead' }
  const mateAgent = { id: 'agent-mate' }
  let contextSpec = null

  function teamServices() {
    contextSpec = null
    return {
      agentTeams: {
        membership: (agent) => {
          if (agent === leadAgent) return { role: 'lead', name: 'lead', id: 'team-1', root: leadAgent }
          if (agent === mateAgent) return { role: 'teammate', name: 'worker-a', id: 'uuid-a', root: leadAgent }
          throw new Error('not a live team member')
        },
      },
      systemPrompt: {
        context: (spec) => { contextSpec = spec },
      },
    }
  }

  const WORKER_C = { name: 'worker-c', description: 'subtask C', provider: 'spawn', context: 'fresh' }
  const FP_C = fingerprint(WORKER_C)

  test('registers a2a-trust:summary at order 117 when both services exist', () => {
    apply(mockContext(teamServices()))
    assert.ok(contextSpec, 'systemPrompt.context must be called')
    assert.equal(contextSpec.name, 'a2a-trust:summary')
    assert.equal(contextSpec.order, 117)
    assert.equal(typeof contextSpec.text, 'function')
  })

  test('text() contributes nothing without a live agent (bare assemble)', () => {
    assert.equal(contextSpec.text({}), '')
    assert.equal(contextSpec.text(undefined), '')
  })

  test('text() survives a non-member agent (membership throws → no contribution)', () => {
    assert.equal(contextSpec.text({ agent: { stranger: true } }), '')
  })

  test('lead text() reflects the in-memory projection refreshed by persist', async () => {
    // This apply instance's projection starts empty; ingest a fresh worker-c
    // batch through it and let the serialized tail settle — persist() must
    // refresh the projection the synchronous seam reads.
    feed(LEAD, { type: 'team/member', seq: 10, time: 20_000, data: { version: 2, teamId: LEAD, member: { id: 'uuid-ccc', ...WORKER_C, phase: 'active' } } })
    feed(LEAD, { type: 'team/task', seq: 11, time: 21_000, data: { version: 2, teamId: LEAD, task: { id: 't3', revision: 1, subject: 's', description: '', status: 'pending', ownerId: 'uuid-ccc', blockedBy: [], writeScopes: [] } } })
    feed(LEAD, { type: 'team/task', seq: 12, time: 22_000, data: { version: 2, teamId: LEAD, task: { id: 't3', revision: 2, subject: 's', description: '', status: 'completed', ownerId: 'uuid-ccc', blockedBy: [], writeScopes: [] } } })
    await settleLedger((l) => l.agents[FP_C]?.stats?.tasksCompleted === 1)
    const out = contextSpec.text({ agent: leadAgent })
    assert.match(out, /worker-c: /)
    assert.match(out, /never override current observations/)
  })

  test('teammate text() is empty in the default lead-only mode', () => {
    assert.equal(contextSpec.text({ agent: mateAgent }), '')
  })

  test('no context registration when the agentTeams service is absent', () => {
    contextSpec = null
    apply(mockContext({ systemPrompt: { context: () => { throw new Error('must not register') } } }))
    assert.equal(contextSpec, null)
  })

  test('off mode (A2A_TRUST_INJECTION) skips registration entirely', () => {
    contextSpec = null
    const prev = process.env.A2A_TRUST_INJECTION
    process.env.A2A_TRUST_INJECTION = 'off'
    try {
      apply(mockContext(teamServices()))
      assert.equal(contextSpec, null)
    } finally {
      if (prev === undefined) delete process.env.A2A_TRUST_INJECTION
      else process.env.A2A_TRUST_INJECTION = prev
    }
  })
})
