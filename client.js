// dsh-a2a-trust client half — settings.section dashboard (L0 observer).
//
// Self-registers as a lazy CJS module (the dsh browser module-loader
// pattern): the host serves this file over /plugins and the browser
// materializes it on demand. React comes from the loader; nothing else
// is imported. The panel is read-only — trust is a signal, not a
// constraint, so the UI shows the ledger and never mutates it.
//
// ID CONTRACT: the self-registration id below MUST equal the package
// name in package.json. The host keys the boot graph row by package
// name (client-modules graphRow(packageName)) and the loader matches
// this registration to that row — stripClientSuffix only strips a
// trailing '/client', there is no other id mapping. A mismatch fails
// bundle arrival with `loaded without registering "<pkg>"`. Pinned by
// test/client-smoke.test.js.
window.__ModuleLoader__.load({
  id: 'dsh-a2a-trust',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const { useState, useEffect, useCallback } = React
    const h = React.createElement

    let _ctx = null

    const CSS = `
.a2t-section { width: 100%; display: flex; flex-direction: column; gap: 14px; color: var(--dsw-alias-label-primary); }
.a2t-header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.a2t-title { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.02em; }
.a2t-sub { margin: 2px 0 0; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.a2t-btn { padding: 6px 14px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); border-radius: 8px; cursor: pointer; font: inherit; font-size: 13px; }
.a2t-btn:hover:not(:disabled) { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.a2t-btn:disabled { opacity: 0.5; cursor: default; }
.a2t-err { padding: 8px 12px; border-radius: 8px; font-size: 12px; color: var(--dsw-alias-fill-danger, #e5484d); background: var(--dsw-alias-bg-layer-2); }
.a2t-empty { padding: 22px 0; text-align: center; font-size: 13px; color: var(--dsw-alias-label-tertiary); }
.a2t-list { display: flex; flex-direction: column; gap: 10px; }
.a2t-card { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.a2t-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.a2t-who { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; min-width: 0; }
.a2t-name { font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.a2t-provider { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-tertiary); }
.a2t-score { flex: 0 0 auto; font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; }
.a2t-score.na { font-size: 12px; font-weight: 400; color: var(--dsw-alias-label-tertiary); }
.a2t-desc { font-size: 12px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.a2t-dims { display: flex; flex-direction: column; gap: 5px; }
.a2t-dim { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.a2t-dim.low { opacity: 0.55; }
.a2t-dim-label { flex: 0 0 3em; color: var(--dsw-alias-label-secondary); }
.a2t-dim-track { flex: 1 1 auto; height: 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.a2t-dim-fill { height: 100%; border-radius: 999px; background: var(--dsw-alias-fill-info, #0091ff); }
.a2t-dim.low .a2t-dim-fill { background: var(--dsw-alias-label-tertiary); }
.a2t-dim-val { flex: 0 0 auto; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary); }
.a2t-dim-n { flex: 0 0 auto; font-size: 10px; color: var(--dsw-alias-label-tertiary); }
.a2t-stats { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
    `

    const DIMS = ['competence', 'reliability', 'communication', 'integrity']
    const DIM_LABELS = { competence: '能力', reliability: '可靠', communication: '沟通', integrity: '正直' }

    function callRPC(method, args) {
      // Static bundle installs reach the host half over the generic
      // connection RPC bridge: channel '/a2a-trust', endpoint 'dashboard'.
      const scope = _ctx && typeof _ctx.get === 'function' ? _ctx : null
      if (scope === null) return Promise.reject(new Error('context unavailable'))
      let connection
      try { connection = scope.get('connection') } catch (e) { connection = undefined }
      if (connection === undefined || connection.rpc === undefined) {
        return Promise.reject(new Error('connection service unavailable'))
      }
      const name = String(method)
      const slash = name.indexOf('/')
      const channel = slash === -1 ? name : name.slice(0, slash)
      const endpoint = slash === -1 ? name : name.slice(slash + 1)
      return connection.rpc.call('/' + channel.replace(/^\/+/, ''), endpoint, args).then((res) => {
        if (res && res.ok) return res.value
        throw new Error((res && res.error && res.error.message) || ('RPC ' + method + ' failed'))
      })
    }

    function dimRow(dim, rec) {
      const value = typeof rec.value === 'number' ? rec.value : 0.5
      const low = rec.lowConfidence !== false
      return h('div', { key: dim, className: 'a2t-dim' + (low ? ' low' : '') },
        h('span', { className: 'a2t-dim-label' }, DIM_LABELS[dim] ?? dim),
        h('div', { className: 'a2t-dim-track' },
          h('div', { className: 'a2t-dim-fill', style: { width: Math.round(value * 100) + '%' } })),
        h('span', { className: 'a2t-dim-val' }, value.toFixed(2)),
        h('span', { className: 'a2t-dim-n' }, low ? '样本少' : (rec.samples ?? 0) + ' 样本'))
    }

    function agentCard(agent) {
      const profile = agent.profile ?? {}
      const score = agent.score
      const stats = agent.stats ?? {}
      const onTime = stats.responsesOnTime ?? 0
      const late = stats.responsesLate ?? 0
      return h('div', { key: agent.fingerprint, className: 'a2t-card' },
        h('div', { className: 'a2t-card-head' },
          h('div', { className: 'a2t-who' },
            h('span', { className: 'a2t-name' }, profile.name || '(未命名)'),
            profile.provider && h('span', { className: 'a2t-provider' }, profile.provider)),
          h('span', { className: 'a2t-score' + (score === null || score === undefined ? ' na' : '') },
            score === null || score === undefined ? '样本不足' : score.toFixed(2))),
        profile.description && h('div', { className: 'a2t-desc' }, profile.description),
        h('div', { className: 'a2t-dims' },
          DIMS.map((dim) => dimRow(dim, agent.dims?.[dim] ?? {}))),
        h('div', { className: 'a2t-stats' },
          `任务 ${stats.tasksCompleted ?? 0} · 工具 ${stats.toolCalls ?? 0}（错 ${stats.toolErrors ?? 0}）`
          + ` · 消息 ${stats.messagesSent ?? 0} · 准时 ${onTime}/${onTime + late}`))
    }

    function TrustPanel() {
      const [data, setData] = useState(null) // { version, updatedAt, agents }
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState(null)

      const refresh = useCallback(() => {
        setBusy(true); setErr(null)
        callRPC('a2a-trust/dashboard', {})
          .then((d) => setData(d))
          .catch((e) => { setData(null); setErr(e.message) })
          .finally(() => setBusy(false))
      }, [])

      useEffect(() => { refresh() }, [refresh])

      const agents = data?.agents ?? []
      return h('div', { className: 'a2t-section' },
        h('div', { className: 'a2t-header' },
          h('div', null,
            h('h3', { className: 'a2t-title' }, '信任指数'),
            h('p', { className: 'a2t-sub' },
              `${agents.length} 个 agent 类型 · 跨会话累积（按类型指纹）· 好挣得慢、坏掉得快 · 全部变更记入审计日志`)),
          h('button', { className: 'a2t-btn', onClick: refresh, disabled: busy }, busy ? '…' : '刷新')),
        err !== null && h('div', { className: 'a2t-err' }, err),
        data === null
          ? (err !== null ? null : h('div', { className: 'a2t-empty' }, '加载中…'))
          : agents.length === 0
            ? h('div', { className: 'a2t-empty' }, '暂无信任数据 —— 启动一个 agent 团队会话，事件会实时积累信任')
            : h('div', { className: 'a2t-list' }, agents.map(agentCard)))
    }

    function apply(ctx) {
      _ctx = ctx
      ctx.effect(() => {
        const el = document.createElement('style')
        el.setAttribute('data-plugin', 'dsh-a2a-trust')
        el.textContent = CSS
        document.head.appendChild(el)
        return () => { el.remove() }
      }, 'a2a-trust: styles')
      let slots = null
      try { slots = typeof ctx.get === 'function' ? ctx.get('slots') : null } catch (e) { slots = null }
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        console.warn('[a2a-trust] settings.section slot unavailable')
        return
      }
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'a2a-trust', order: 40, label: () => '信任指数' },
        (props) => h(TrustPanel, props),
      ))
    }

    const _plugin = { inject: ['slots'], apply }
    exports.apply = function applyCtx(ctx) { _ctx = ctx; return _plugin.apply(ctx) }
    exports.inject = _plugin.inject
    return module.exports
  }
})
