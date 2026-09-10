/**
 * injection.js unit tests — the L1 advisor rendering contract.
 *
 * Projection rows come from the real trust.js summarize() so the renderer
 * is asserted against the exact shape the host half will feed it. The
 * governance red lines are pinned here: advisory disclaimer always last,
 * byte-stable output, off-mode contributes nothing, budget truncation
 * never eats the disclaimer.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { createAgentEntry, applyEvidence, summarize } from '../trust.js'
import { normalizeInjectionConfig, renderTrustContext, INJECTION_MODES, DEFAULT_MAX_TOKENS } from '../injection.js'

/** A summarized agent row with `good` competent samples and task counters. */
function row(name, { samples = 5, tasks = 1, tools = 4, errors = 0, messages = 0 } = {}) {
  let entry = createAgentEntry({ name, description: `worker ${name}`, provider: 'spawn', context: 'fresh' }, 1000)
  for (let i = 0; i < samples; i++) entry = { ...entry, trust: applyEvidence(entry.trust, 'competence', 0.8, 2000 + i).record }
  if (tasks > 0) entry = { ...entry, trust: applyEvidence(entry.trust, 'reliability', 1, 3000).record, stats: { ...entry.stats, tasksCompleted: tasks } }
  entry = { ...entry, stats: { ...entry.stats, toolCalls: tools, toolErrors: errors, messagesSent: messages } }
  return summarize(entry)
}

/** The same row but every dimension below the confidence floor. */
function lowRow(name) {
  let entry = createAgentEntry({ name, description: `worker ${name}`, provider: 'spawn', context: 'fresh' }, 1000)
  entry = { ...entry, trust: applyEvidence(entry.trust, 'competence', 0.8, 2000).record }
  return summarize(entry)
}

const DISCLAIMER = 'Historical stats, may be stale, never override current observations.'
const LEAD = { role: 'lead', name: 'lead', id: 'team-1', root: {} }
const MATE_A = { role: 'teammate', name: 'worker-a', id: 'uuid-a', root: {} }

describe('normalizeInjectionConfig', () => {
  test('accepts each documented mode string', () => {
    for (const mode of INJECTION_MODES) {
      assert.deepEqual(normalizeInjectionConfig(mode), { mode, maxTokens: DEFAULT_MAX_TOKENS })
    }
  })

  test('accepts the object form with maxTokens', () => {
    assert.deepEqual(normalizeInjectionConfig({ mode: 'all', maxTokens: 120 }), { mode: 'all', maxTokens: 120 })
  })

  test('falls back to lead-only defaults on garbage', () => {
    assert.deepEqual(normalizeInjectionConfig('bogus'), { mode: 'lead-only', maxTokens: DEFAULT_MAX_TOKENS })
    assert.deepEqual(normalizeInjectionConfig(null), { mode: 'lead-only', maxTokens: DEFAULT_MAX_TOKENS })
    assert.deepEqual(normalizeInjectionConfig(undefined), { mode: 'lead-only', maxTokens: DEFAULT_MAX_TOKENS })
    assert.deepEqual(normalizeInjectionConfig({ mode: 'all', maxTokens: 'lots' }), { mode: 'all', maxTokens: DEFAULT_MAX_TOKENS })
    assert.deepEqual(normalizeInjectionConfig({ mode: 'all', maxTokens: 5 }), { mode: 'all', maxTokens: DEFAULT_MAX_TOKENS })
  })
})

describe('renderTrustContext gating', () => {
  test('no membership (bare assemble) contributes nothing', () => {
    assert.equal(renderTrustContext({ ledgerProjection: [row('worker-a')], membership: null, mode: 'lead-only' }), '')
  })

  test('off mode contributes nothing even with data', () => {
    assert.equal(renderTrustContext({ ledgerProjection: [row('worker-a')], membership: LEAD, mode: 'off' }), '')
  })

  test('lead-only skips teammates', () => {
    assert.equal(renderTrustContext({ ledgerProjection: [row('worker-a')], membership: MATE_A, mode: 'lead-only' }), '')
  })

  test('lead with no tracked data contributes nothing', () => {
    assert.equal(renderTrustContext({ ledgerProjection: [], membership: LEAD, mode: 'lead-only' }), '')
  })
})

describe('renderTrustContext lead view', () => {
  const workers = [row('worker-a'), row('worker-b', { samples: 5, tasks: 1, tools: 2, errors: 1 })]

  test('renders a header, one deterministic row per worker, and the disclaimer last', () => {
    const out = renderTrustContext({ ledgerProjection: workers, membership: LEAD, mode: 'lead-only' })
    const lines = out.split('\n')
    assert.match(lines[0], /trust of agent types/i)
    assert.match(lines[1], /^worker-a: /)
    assert.match(lines[2], /^worker-b: /)
    assert.equal(lines[lines.length - 1], DISCLAIMER)
    // 5 x q=0.8 from 0.5: 0.5→0.53→0.557→0.5813→0.60317→0.622853 → 0.62
    assert.match(lines[1], /competence 0\.62\/5/)
    assert.match(lines[1], /tools 4\/0 err/)
  })

  test('low-confidence dimensions are labelled', () => {
    const out = renderTrustContext({ ledgerProjection: [lowRow('shy-worker')], membership: LEAD, mode: 'lead-only' })
    // 1 x q=0.8 from 0.5: 0.5 + 0.1*(0.8-0.5) = 0.53
    assert.match(out, /competence 0\.53\/1 low-confidence/)
  })

  test('output is byte-stable across calls (debounce contract)', () => {
    const a = renderTrustContext({ ledgerProjection: workers, membership: LEAD, mode: 'lead-only' })
    const b = renderTrustContext({ ledgerProjection: workers, membership: LEAD, mode: 'lead-only' })
    assert.equal(a, b)
  })

  test('the lead\'s own named entry is excluded from the lead view', () => {
    const leadRow = row('lead')
    const out = renderTrustContext({ ledgerProjection: [leadRow, row('worker-a')], membership: LEAD, mode: 'lead-only' })
    assert.doesNotMatch(out, /^lead: /m)
    assert.match(out, /^worker-a: /m)
  })
})

describe('renderTrustContext teammate view (all mode)', () => {
  test('renders self profile plus collaborators under a peer header', () => {
    const out = renderTrustContext({
      ledgerProjection: [row('worker-a'), row('worker-b')],
      membership: MATE_A,
      mode: 'all',
    })
    const lines = out.split('\n')
    assert.match(lines[0], /Your cross-session trust profile/)
    assert.equal(lines[1].startsWith('worker-a: '), true)
    assert.ok(lines.includes('Recent trust of your collaborators:'))
    assert.ok(lines.some((l) => l.startsWith('worker-b: ')))
    assert.equal(lines[lines.length - 1], DISCLAIMER)
  })

  test('self only — no peer header when nothing else has data', () => {
    const out = renderTrustContext({ ledgerProjection: [row('worker-a')], membership: MATE_A, mode: 'all' })
    assert.ok(out.startsWith('Your cross-session trust profile:'))
    assert.ok(out.includes('worker-a: '))
    assert.equal(out.includes('collaborators'), false)
  })

  test('untracked teammate sees only collaborators under the peer header', () => {
    const out = renderTrustContext({ ledgerProjection: [row('worker-b')], membership: MATE_A, mode: 'all' })
    assert.ok(out.startsWith('Recent trust of your collaborators:'))
    assert.match(out, /worker-b: /)
    assert.equal(out.includes('Your cross-session trust profile'), false)
  })
})

describe('renderTrustContext budget', () => {
  test('tight maxTokens truncates rows from the tail but never the disclaimer', () => {
    const many = ['w1', 'w2', 'w3', 'w4', 'w5'].map((n) => row(n))
    // 40 tokens ≈ 160 chars: one ~95-char row fits, a second does not.
    const out = renderTrustContext({ ledgerProjection: many, membership: LEAD, mode: 'lead-only', maxTokens: 40 })
    assert.ok(out.length > 0)
    assert.equal(out.endsWith(DISCLAIMER), true)
    assert.match(out, /^w1: /m) // freshest row survives
    assert.equal(/^w2: /m.test(out), false) // next row dropped
    assert.equal(/^w5: /m.test(out), false)
  })

  test('a budget too small for any whole row contributes nothing', () => {
    const out = renderTrustContext({ ledgerProjection: [row('long-name-worker-x')], membership: LEAD, mode: 'lead-only', maxTokens: 16 })
    // 16 tokens ≈ 64 chars < one row — dropping the only row leaves an empty
    // body, and a bare header + disclaimer is worse than nothing.
    assert.equal(out, '')
  })
})
