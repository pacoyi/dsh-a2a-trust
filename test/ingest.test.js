/**
 * ingest.js unit tests — event → evidence mapping on the real session-log
 * shapes captured from a live agent-team run (test/fixtures), plus
 * synthetic V2/V3 envelope variants.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Ingestor } from '../ingest.js'
import { fingerprint } from '../trust.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = readFileSync(join(here, 'fixtures', 'team-run-sample.jsonl'), 'utf8')
  .split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))

const WORKER_A = {
  id: '10000000-0000-4000-8000-000000000002',
  name: 'worker-a',
  description: '处理子任务A的 worker',
  provider: 'spawn',
  context: 'fresh',
}
const FP_A = fingerprint(WORKER_A)

const memberEvent = (member = WORKER_A, time = 1000) => ({
  type: 'team/member', seq: 1, time,
  data: { version: 2, teamId: 'session-abc', member },
})

const taskEvent = (taskId, status, ownerId, revision, time) => ({
  type: 'team/task', seq: 2, time,
  data: { version: 2, teamId: 'session-abc', task: { id: taskId, revision, subject: `t-${taskId}`, description: '', status, ownerId, blockedBy: [], writeScopes: [] } },
})

const toolCall = (callId, time, session = WORKER_A.id) => ({
  type: 'tool/call', seq: 3, time,
  data: { turn: 1, step: 1, callId, name: 'read_file', arguments: '{}' },
})

/** V3-guaranteed error spelling: data.error ⇒ content[0].isError === true. */
const toolResultV3 = (callId, time, isError, session = WORKER_A.id) => ({
  type: 'tool/result', seq: 4, time, surfaceOp: 'append', sourceEventSeqs: [3],
  data: {
    turn: 1, step: 1, error: isError ? { message: 'boom' } : undefined,
    message: {
      source: { kind: 'tool', callId },
      content: [{ type: 'tool-result', isError }],
      role: 'user', id: 'r1',
    },
  },
  session, // backfill tests attach the session; live tests pass it separately
})

const teamMessage = (senderId, messageId, time) => ({
  type: 'user/message', seq: 5, time, surfaceOp: 'append',
  data: {
    content: [{ type: 'text', text: 'done' }],
    source: { kind: 'team-message', teamId: 'session-abc', messageId, senderId },
    role: 'user', id: 'm1',
  },
})

describe('fixture sanity (real shapes)', () => {
  test('fixture contains the expected event types', () => {
    const types = new Set(fixture.map((e) => e.type))
    assert.equal(types.has('team/task'), true)
    assert.equal(types.has('team/member'), true)
    assert.equal(types.has('tool/call'), true)
    assert.equal(types.has('tool/result'), true)
  })

  test('fixture events feed without throwing', () => {
    const ing = new Ingestor()
    for (const e of fixture) ing.feed('session-fixture', e)
    assert.equal(ing.members.size > 0, true)
  })
})

describe('member registration & attribution', () => {
  test('team/member registers the fingerprint', () => {
    const ing = new Ingestor()
    ing.feed('session-abc', memberEvent())
    const m = ing.resolveMember(WORKER_A.id)
    assert.equal(m.fingerprint, FP_A)
    assert.equal(m.profile.name, 'worker-a')
  })

  test('suffix matching resolves session-<uuid> lead dirs', () => {
    const ing = new Ingestor()
    ing.feed('session-abc', memberEvent())
    assert.equal(ing.resolveMember(`session-${WORKER_A.id}`).fingerprint, FP_A)
  })

  test('unknown sessions resolve to undefined (no attribution)', () => {
    const ing = new Ingestor()
    ing.feed('session-abc', memberEvent())
    assert.equal(ing.resolveMember('nope-uuid'), undefined)
  })

  test('garbage member events are ignored', () => {
    const ing = new Ingestor()
    assert.deepEqual(ing.feed('s', { type: 'team/member', data: {} }), [])
    assert.deepEqual(ing.feed('s', { type: 'team/member' }), [])
  })
})

describe('task evidence', () => {
  test('pending → completed emits competence+reliability for the owner', () => {
    const ing = new Ingestor()
    ing.feed('session-abc', memberEvent())
    assert.deepEqual(ing.feed('session-abc', taskEvent('t1', 'pending', WORKER_A.id, 1, 1000)), [])
    const out = ing.feed('session-abc', taskEvent('t1', 'in_progress', WORKER_A.id, 2, 2000))
    assert.deepEqual(out, []) // in_progress is not terminal evidence
    const done = ing.feed('session-abc', taskEvent('t1', 'completed', WORKER_A.id, 3, 3000))
    assert.equal(done.length, 2)
    assert.equal(done[0].fingerprint, FP_A)
    assert.equal(done[0].dim, 'competence')
    assert.equal(done[0].quality, 1.0)
    assert.equal(done[1].dim, 'reliability')
  })

  test('deleted is ambiguous: no trust move', () => {
    const ing = new Ingestor()
    ing.feed('session-abc', memberEvent())
    ing.feed('session-abc', taskEvent('t2', 'pending', WORKER_A.id, 1, 1000))
    assert.deepEqual(ing.feed('session-abc', taskEvent('t2', 'deleted', WORKER_A.id, 2, 2000)), [])
  })

  test('unowned task completion is skipped', () => {
    const ing = new Ingestor()
    ing.feed('session-abc', memberEvent())
    ing.feed('session-abc', taskEvent('t3', 'pending', undefined, 1, 1000))
    assert.deepEqual(ing.feed('session-abc', taskEvent('t3', 'completed', undefined, 2, 2000)), [])
  })

  test('same-status rewrite emits nothing (idempotent snapshots)', () => {
    const ing = new Ingestor()
    ing.feed('session-abc', memberEvent())
    ing.feed('session-abc', taskEvent('t4', 'pending', WORKER_A.id, 1, 1000))
    assert.deepEqual(ing.feed('session-abc', taskEvent('t4', 'pending', WORKER_A.id, 2, 2000)), [])
  })
})

describe('tool evidence (V2/V3 tolerant)', () => {
  test('V3 spelling: success via content[0].isError=false', () => {
    const ing = new Ingestor()
    ing.feed('session-abc', memberEvent())
    ing.feed(WORKER_A.id, toolCall('c1', 1000))
    const out = ing.feed(WORKER_A.id, toolResultV3('c1', 2000, false))
    assert.equal(out.length, 1)
    assert.equal(out[0].kind, 'tool-success')
    assert.equal(out[0].dim, 'competence')
    assert.equal(out[0].quality, 0.8)
    assert.equal(out[0].detail.durationMs, 1000)
  })

  test('V3 spelling: error via data.error + isError=true', () => {
    const ing = new Ingestor()
    ing.feed('session-abc', memberEvent())
    ing.feed(WORKER_A.id, toolCall('c2', 1000))
    const out = ing.feed(WORKER_A.id, toolResultV3('c2', 2000, true))
    assert.equal(out[0].kind, 'tool-error')
    assert.equal(out[0].quality, 0.0)
  })

  test('V2-era spelling: data.error alone flags the error', () => {
    const ing = new Ingestor()
    ing.feed('session-abc', memberEvent())
    ing.feed(WORKER_A.id, toolCall('c3', 1000))
    const out = ing.feed(WORKER_A.id, {
      type: 'tool/result', seq: 9, time: 2000,
      data: { turn: 1, step: 1, error: { message: 'boom' }, message: { source: { kind: 'tool', callId: 'c3' }, content: [{ type: 'tool-result' }] } },
    })
    assert.equal(out[0].kind, 'tool-error')
  })

  test('unattributable tool calls (lead-only session) emit nothing', () => {
    const ing = new Ingestor()
    ing.feed('session-abc', memberEvent())
    ing.feed('some-unknown-session', toolCall('c4', 1000))
    const out = ing.feed('some-unknown-session', toolResultV3('c4', 2000, false))
    assert.deepEqual(out, [])
  })

  test('result without a tracked call is skipped', () => {
    const ing = new Ingestor()
    ing.feed('session-abc', memberEvent())
    assert.deepEqual(ing.feed(WORKER_A.id, toolResultV3('ghost', 2000, false)), [])
  })
})

describe('communication evidence', () => {
  test('team-message from a member is mild-good communication', () => {
    const ing = new Ingestor()
    ing.feed('session-abc', memberEvent())
    const out = ing.feed(WORKER_A.id, teamMessage(WORKER_A.id, 'm1', 1000))
    assert.equal(out.length, 1)
    assert.equal(out[0].kind, 'message-sent')
    assert.equal(out[0].dim, 'communication')
    assert.equal(out[0].quality, 0.7)
  })

  test('inbox-splice → assistant reply latency bands', () => {
    const ing = new Ingestor()
    ing.feed('session-abc', memberEvent())
    // teammate inbox delivery
    ing.feed('session-abc', {
      type: 'agent/inbox/spliced', seq: 10, time: 1000,
      data: { target: WORKER_A.id, start: 0, inserted: [] },
    })
    const fast = ing.feed(WORKER_A.id, { type: 'assistant/message', seq: 11, time: 1000 + 10_000, data: {} })
    assert.equal(fast[0].kind, 'response-latency')
    assert.equal(fast[0].quality, 1.0) // <60s
  })

  test('late reply (>10 min) is strong-bad', () => {
    const ing = new Ingestor()
    ing.feed('session-abc', memberEvent())
    ing.feed('session-abc', {
      type: 'agent/inbox/spliced', seq: 10, time: 1000,
      data: { target: `session-${WORKER_A.id}`, start: 0, inserted: [] },
    })
    const late = ing.feed(WORKER_A.id, { type: 'assistant/message', seq: 11, time: 1000 + 700_000, data: {} })
    assert.equal(late[0].quality, 0.0)
  })

  test('next-turn splice (Lead user input) is never an evidence anchor', () => {
    const ing = new Ingestor()
    ing.feed('session-abc', memberEvent())
    ing.feed('session-abc', {
      type: 'agent/inbox/spliced', seq: 10, time: 1000,
      data: { target: 'next-turn', start: 0, inserted: [{ content: [] }] },
    })
    assert.deepEqual(ing.feed('session-abc', { type: 'assistant/message', seq: 11, time: 2000, data: {} }), [])
  })

  test('reply without a pending splice emits nothing', () => {
    const ing = new Ingestor()
    ing.feed('session-abc', memberEvent())
    assert.deepEqual(ing.feed(WORKER_A.id, { type: 'assistant/message', seq: 11, time: 2000, data: {} }), [])
  })
})

describe('robustness', () => {
  test('null / malformed events never throw', () => {
    const ing = new Ingestor()
    assert.deepEqual(ing.feed('s', null), [])
    assert.deepEqual(ing.feed('s', {}), [])
    assert.deepEqual(ing.feed('s', { type: 42 }), [])
    assert.deepEqual(ing.feed('s', { type: 'team/member', data: { member: null } }), [])
    assert.deepEqual(ing.feed('s', { type: 'team/member', data: {} }), [])
    // valid member events legitimately emit registration evidence — even
    // with a null sessionId (attribution is by member.id, not sessionId)
    const reg = ing.feed(null, memberEvent())
    assert.equal(reg.length, 1)
    assert.equal(reg[0].kind, 'member-registered')
  })

  test('pending tool table is bounded', () => {
    const ing = new Ingestor()
    for (let i = 0; i < 600; i++) ing.feed('s', toolCall(`c-${i}`, i))
    assert.equal(ing.pendingTools.size <= 512, true)
  })
})
