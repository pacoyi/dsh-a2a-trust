/**
 * trust.js unit tests — EWMA math, fingerprint identity, confidence gates.
 * Pure functions; no IO, no mocking.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  DIMENSIONS, ALPHA_GOOD, ALPHA_BAD, NEUTRAL, LOW_CONFIDENCE_SAMPLES,
  fingerprint, createTrustRecord, applyEvidence, createAgentEntry,
  totalScore, isLowConfidence, pushHistory, summarize, HISTORY_LIMIT,
} from '../trust.js'

const PROFILE = {
  name: 'worker-a',
  description: '处理子任务A的 worker',
  provider: 'spawn',
  context: 'fresh',
}

describe('fingerprint (SPEC 3.4 identity)', () => {
  test('deterministic and field-sensitive', () => {
    const fp1 = fingerprint(PROFILE)
    assert.equal(fp1, fingerprint({ ...PROFILE }))
    assert.equal(fp1.length, 64)
    // every field participates
    for (const key of Object.keys(PROFILE)) {
      const mutated = { ...PROFILE, [key]: `${PROFILE[key]}-x` }
      assert.notEqual(fp1, fingerprint(mutated), `${key} must affect the fingerprint`)
    }
  })

  test('missing fields degrade to empty strings, never throw', () => {
    assert.equal(typeof fingerprint({}), 'string')
    assert.equal(typeof fingerprint(undefined), 'string')
    assert.equal(fingerprint({ name: 'a' }), fingerprint({ name: 'a', description: '', provider: '', context: '' }))
  })

  test('same name + different description = different agent type (honest semantics)', () => {
    const v1 = fingerprint({ name: 'w', description: 'v1', provider: 'p', context: 'fresh' })
    const v2 = fingerprint({ name: 'w', description: 'v2', provider: 'p', context: 'fresh' })
    assert.notEqual(v1, v2)
  })
})

describe('asymmetric EWMA (SPEC 3.3)', () => {
  test('good evidence compounds slowly: 0.5 → 0.55 → 0.595', () => {
    let record = createTrustRecord()
    record = applyEvidence(record, 'competence', 1.0, 1000).record
    assert.equal(record.competence.value, 0.55)
    record = applyEvidence(record, 'competence', 1.0, 2000).record
    assert.equal(record.competence.value, 0.595)
  })

  test('bad evidence bites fast: 0.5 → 0.35', () => {
    const { record } = applyEvidence(createTrustRecord(), 'competence', 0.0, 1000)
    assert.equal(record.competence.value, 0.35) // 0.3*0 + 0.7*0.5
  })

  test('asymmetry: one bad step needs multiple good steps to repair', () => {
    let record = createTrustRecord()
    record = applyEvidence(record, 'competence', 0.0, 1000).record // 0.35
    assert.equal(record.competence.value < 0.5, true)
    let repairs = 0
    while (record.competence.value < 0.5 && repairs < 20) {
      record = applyEvidence(record, 'competence', 1.0, 1000 + repairs).record
      repairs += 1
    }
    // 0.35 → 0.415 → 0.4735 → 0.52615: one bad step (−0.15) costs three
    // good steps (~+0.065 each) to repair
    assert.equal(repairs, 3)
  })

  test('quality is clamped to [0,1] and NaN-safe', () => {
    const { record } = applyEvidence(createTrustRecord(), 'competence', 5, 1000)
    assert.equal(record.competence.value, 0.55) // clamped to 1
    const r2 = applyEvidence(createTrustRecord(), 'competence', -1, 1000).record
    assert.equal(r2.competence.value, 0.35) // clamped to 0
    assert.equal(applyEvidence(createTrustRecord(), 'competence', NaN, 1).record.competence.value, 0.5)
  })

  test('neutral 0.5 uses ALPHA_GOOD and still counts a sample', () => {
    const { record } = applyEvidence(createTrustRecord(), 'reliability', 0.5, 1000)
    assert.equal(record.reliability.value, 0.5)
    assert.equal(record.reliability.samples, 1)
  })

  test('unknown dimension throws', () => {
    assert.throws(() => applyEvidence(createTrustRecord(), 'bogus', 1.0))
  })

  test('dimensions are independent', () => {
    let record = createTrustRecord()
    record = applyEvidence(record, 'competence', 0.0, 1000).record
    assert.equal(record.reliability.value, 0.5)
    assert.equal(record.integrity.value, 0.5)
  })

  test('value stays in [0,1] under extreme hammering', () => {
    let record = createTrustRecord()
    for (let i = 0; i < 100; i++) record = applyEvidence(record, 'competence', i % 2 ? 0 : 1, i).record
    assert.equal(record.competence.value <= 1 && record.competence.value >= 0, true)
  })
})

describe('confidence gates', () => {
  test('low confidence below the sample floor', () => {
    const entry = createAgentEntry(PROFILE)
    assert.equal(isLowConfidence(entry, 'competence'), true)
    let record = entry.trust
    for (let i = 0; i < LOW_CONFIDENCE_SAMPLES; i++) record = applyEvidence(record, 'competence', 1.0, i).record
    const enriched = { ...entry, trust: record }
    assert.equal(isLowConfidence(enriched, 'competence'), false)
  })

  test('totalScore is null until some dim is confident', () => {
    const entry = createAgentEntry(PROFILE)
    assert.equal(totalScore(entry), null)
    let record = entry.trust
    for (let i = 0; i < LOW_CONFIDENCE_SAMPLES; i++) record = applyEvidence(record, 'competence', 1.0, i).record
    const enriched = { ...entry, trust: record }
    assert.equal(totalScore(enriched) !== null, true)
    assert.equal(totalScore(enriched) > 0.5, true)
  })

  test('weights are honoured', () => {
    const entry = createAgentEntry(PROFILE)
    let record = entry.trust
    for (let i = 0; i < 10; i++) record = applyEvidence(record, 'competence', 1.0, i).record
    for (let i = 0; i < 10; i++) record = applyEvidence(record, 'communication', 0.0, i).record
    const enriched = { ...entry, trust: record }
    const w1 = totalScore(enriched, { competence: 1, communication: 0 })
    const w2 = totalScore(enriched, { competence: 0, communication: 1 })
    assert.equal(w1 > w0_95(w2), true) // competence-only beats communication-only
  })
})

function w0_95(v) { return v * 0.95 }

describe('history ring + summarize', () => {
  test('history is bounded', () => {
    let entry = createAgentEntry(PROFILE)
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) {
      entry = { ...entry, history: pushHistory(entry, { i }) }
    }
    assert.equal(entry.history.length, HISTORY_LIMIT)
    assert.equal(entry.history[entry.history.length - 1].i, HISTORY_LIMIT + 9)
  })

  test('summarize carries confidence flags and stats', () => {
    const entry = createAgentEntry(PROFILE)
    const s = summarize(entry)
    assert.equal(s.profile.name, 'worker-a')
    assert.equal(s.score, null)
    for (const dim of DIMENSIONS) {
      assert.equal(s.dims[dim].lowConfidence, true)
      assert.equal(s.dims[dim].value, NEUTRAL)
    }
  })
})
