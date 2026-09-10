// client.js render smoke — the layer the RPC suites cannot see.
//
// The browser half is a window.__ModuleLoader__ self-registration whose
// factory receives React from the host loader (memory-lite proven pattern).
// This suite renders client.js outside any browser:
//   - registration: module id, apply/inject exports
//   - structure assertions on a hook-mocked React (inert useState with
//     per-ordinal injection, no-op effects) — zero dependencies
//   - a real-React renderToString smoke when the harness checkout is
//     present (A2A_TRUST_REACT_DIR to override) proves every surface
//     renders to HTML without throwing
//
// Dashboard rows come from the real trust.js summarize() so the client
// and the host projection are asserted against one shape contract.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { createAgentEntry, applyEvidence, summarize, DIMENSIONS } from '../trust.js'

const require = createRequire(import.meta.url)
const CLIENT = join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js')

// useState call ordinals in TrustPanel declaration order.
const PANEL = { data: 0, busy: 1, err: 2 }

function loadClient() {
  const source = readFileSync(CLIENT, 'utf8')
  let captured = null
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: (def) => { captured = def } } } })
  assert.ok(captured, 'client.js must register through window.__ModuleLoader__')
  return captured
}

// Hook-mocked React: createElement builds plain objects (flattening array
// children like React does), useState injects by ordinal, effects never run.
function mockReact(injections) {
  let idx = 0
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState(init) {
      const i = idx++
      const value = i in injections ? injections[i] : (typeof init === 'function' ? init() : init)
      return [value, () => {}]
    },
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (init) => ({ current: init }),
  }
}

// Boot the module against mocked React and capture the settings card.
function mountCard(injections) {
  const def = loadClient()
  const mod = def.factory(() => mockReact(injections))
  let card = null
  mod.apply({
    effect: () => () => {},
    get: (key) => key === 'slots'
      ? { inject: (_slot, register) => register(), register: (_meta, comp) => { card = comp } }
      : null,
  })
  assert.ok(card, 'settings.section registration must produce the card component')
  return card({}).type({}) // unwrap h(TrustPanel, props) -> execute TrustPanel
}

function childClasses(el) {
  return (el.children ?? []).map(c => (!c ? null : (typeof c.type === 'function' ? '[component]' : (c.props.className ?? c.type))))
}

function findChild(el, className) {
  return (el.children ?? []).find(c => c && c.props && c.props.className === className)
}

// A realistic agent row: five good competence samples — exactly at the
// LOW_CONFIDENCE_SAMPLES floor, so competence is confident (score 1.00)
// while the other three dimensions stay low-sample.
function sampleAgent() {
  let entry = createAgentEntry({ name: 'worker-a', description: '处理子任务A的 worker', provider: 'spawn', context: 'fresh' }, 1000)
  for (let i = 0; i < 5; i++) entry = { ...entry, trust: applyEvidence(entry.trust, 'competence', 1, 2000 + i).record }
  return summarize(entry)
}

test('client.js registers as a dsh module with apply/inject exports', () => {
  const def = loadClient()
  assert.equal(def.id, 'dsh-a2a-trust')
  assert.equal(typeof def.factory, 'function')
  const mod = def.factory(() => mockReact({}))
  assert.equal(typeof mod.apply, 'function')
  // join, not deepEqual: the module runs inside a vm realm whose array
  // prototype never passes host-side structural equality
  assert.equal(mod.inject.join(','), 'slots')
})

test('TrustPanel renders header and empty state before data arrives', () => {
  const tree = mountCard({ [PANEL.data]: null, [PANEL.err]: null })
  assert.deepEqual(childClasses(tree), ['a2t-header', null, 'a2t-empty'])
  assert.equal(tree.children[2].children[0], '加载中…')
  const header = findChild(tree, 'a2t-header')
  assert.equal(header.children.length, 2, 'header holds title block and refresh button only')
})

test('TrustPanel shows the zero-agent empty state after a clean load', () => {
  const tree = mountCard({ [PANEL.data]: { version: 1, updatedAt: null, agents: [] }, [PANEL.err]: null })
  assert.deepEqual(childClasses(tree), ['a2t-header', null, 'a2t-empty'])
  assert.equal(tree.children[2].children[0], '暂无信任数据 —— 启动一个 agent 团队会话，事件会实时积累信任')
})

test('TrustPanel shows the error banner and no list on RPC failure', () => {
  const tree = mountCard({ [PANEL.data]: null, [PANEL.err]: 'connection service unavailable' })
  const classes = childClasses(tree)
  assert.equal(classes[1], 'a2t-err')
  assert.equal(tree.children[1].children[0], 'connection service unavailable')
  // the loading branch is suppressed once err is set
  assert.equal(classes[2], null)
})

test('agent card renders profile, score badge, four dim rows, and stats', () => {
  const agent = sampleAgent() // score is null: other dims have 0 samples
  const tree = mountCard({ [PANEL.data]: { version: 1, updatedAt: 1, agents: [agent] }, [PANEL.err]: null })
  assert.deepEqual(childClasses(tree), ['a2t-header', null, 'a2t-list'])
  const card = tree.children[2].children[0]
  assert.equal(card.props.className, 'a2t-card')

  const head = findChild(card, 'a2t-card-head')
  const who = findChild(head, 'a2t-who')
  assert.equal(who.children[0].children[0], 'worker-a')
  assert.equal(who.children[1].children[0], 'spawn')
  const score = findChild(head, 'a2t-score')
  // five good samples at α=0.1 walk 0.5→0.55→0.595→0.6355→0.672→0.705,
  // so the confident score is 0.70 — trust is earned in small steps
  assert.equal(score.props.className, 'a2t-score')
  assert.equal(score.children[0], '0.70')

  assert.equal(findChild(card, 'a2t-desc').children[0], '处理子任务A的 worker')

  const dims = findChild(card, 'a2t-dims')
  assert.equal(dims.children.length, DIMENSIONS.length, 'one row per dimension')
  const byLabel = Object.fromEntries(dims.children.map((row) => [row.children[0].children[0], row]))
  assert.ok(byLabel['能力'], 'competence row labelled in Chinese')
  // five samples ≥ LOW_CONFIDENCE_SAMPLES → confident row, shows the count
  assert.equal(byLabel['能力'].props.className, 'a2t-dim')
  assert.equal(byLabel['能力'].children[3].children[0], '5 样本')
  assert.equal(byLabel['能力'].children[2].children[0], '0.70')
  assert.equal(byLabel['能力'].children[1].children[0].props.style.width, '70%')
  // untouched dimensions stay low-confidence: dimmed class + hint, no samples
  for (const label of ['可靠', '沟通', '正直']) {
    assert.equal(byLabel[label].props.className, 'a2t-dim low', `${label} row carries the low-confidence class`)
    assert.equal(byLabel[label].children[3].children[0], '样本少')
  }

  const stats = findChild(card, 'a2t-stats')
  assert.equal(stats.children[0], '任务 0 · 工具 0（错 0） · 消息 0 · 准时 0/0')
})

test('agent card tolerates missing dims, profile fields, and stats', () => {
  const tree = mountCard({ [PANEL.data]: { version: 1, agents: [{ fingerprint: 'fpx', profile: {}, dims: {}, score: null, stats: {} }] }, [PANEL.err]: null })
  const card = tree.children[2].children[0]
  const head = findChild(card, 'a2t-card-head')
  const who = findChild(head, 'a2t-who')
  assert.equal(who.children[0].children[0], '(未命名)')
  // `provider && h(...)` leaves an undefined slot in mocked children; only
  // the real render drops it — assert on the surviving nodes
  assert.equal(who.children.filter(Boolean).length, 1, 'no provider chip when provider is empty')
  const score = findChild(head, 'a2t-score na')
  assert.equal(score.children[0], '样本不足')
  assert.equal(findChild(card, 'a2t-dims').children.length, 4, 'dim rows render even for an empty dims map')
  const row = findChild(card, 'a2t-dims').children[0]
  assert.equal(row.children[2].children[0], '0.50', 'missing dim falls back to neutral 0.5')
})

// Real-React renderToString smoke: proves no render path throws. Optional —
// skipped when the harness checkout (or A2A_TRUST_REACT_DIR) is not around.
const REACT_DIR_CANDIDATES = [
  process.env.A2A_TRUST_REACT_DIR,
  // repo root → up two levels (workspace) → sibling harness checkout
  join(dirname(CLIENT), '..', '..', 'deepseek-harness', 'apps', 'web', 'node_modules'),
].filter(Boolean)

function resolveRealReact() {
  for (const dir of REACT_DIR_CANDIDATES) {
    try {
      const React = require(join(dir, 'react'))
      const { renderToString } = require(join(dir, 'react-dom', 'server'))
      if (typeof renderToString === 'function') return { React, renderToString }
    } catch { /* try the next candidate */ }
  }
  return null
}

const real = resolveRealReact()
test('renderToString smoke: every card surface renders without throwing', { skip: real === null ? 'real react not found (set A2A_TRUST_REACT_DIR)' : false }, () => {
  const inertReact = (injections) => {
    let idx = 0
    const base = real.React
    return {
      ...base,
      useState(init) {
        const i = idx++
        const value = i in injections ? injections[i] : (typeof init === 'function' ? init() : init)
        return [value, () => {}]
      },
      useEffect: () => {},
      useCallback: (fn) => fn,
      useRef: (init) => ({ current: init }),
    }
  }
  const mount = (injections) => {
    const def = loadClient()
    const mod = def.factory(() => inertReact(injections))
    let card = null
    mod.apply({
      effect: () => () => {},
      get: (key) => key === 'slots'
        ? { inject: (_slot, register) => register(), register: (_meta, comp) => { card = comp } }
        : null,
    })
    return card({})
  }

  const loading = real.renderToString(mount({ [PANEL.data]: null, [PANEL.err]: null }))
  assert.ok(loading.includes('信任指数') && loading.includes('加载中'))

  const empty = real.renderToString(mount({ [PANEL.data]: { version: 1, agents: [] }, [PANEL.err]: null }))
  assert.ok(empty.includes('暂无信任数据'))

  const failed = real.renderToString(mount({ [PANEL.data]: null, [PANEL.err]: 'boom' }))
  assert.ok(failed.includes('boom'))

  const listed = real.renderToString(mount({ [PANEL.data]: { version: 1, agents: [sampleAgent()] }, [PANEL.err]: null }))
  assert.ok(listed.includes('worker-a') && listed.includes('0.70') && listed.includes('处理子任务A的 worker'))
})
