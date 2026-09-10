/**
 * dsh-a2a-trust — L1 advisor rendering (pure functions).
 *
 * Renders the trust summary injected into model context through the
 * systemPrompt.context() seam (the KV-cache-safe PromptContext channel —
 * the same mechanism the approval service uses for its policy sentence).
 * The seam is synchronous, so callers feed an in-memory projection; this
 * module never touches the filesystem.
 *
 * Governance contract (SPEC 2.0/2.2): the output is advisory only. It
 * always ends with the disclaimer sentence, is byte-stable for identical
 * inputs (the agent loop only appends a snapshot when the bytes change,
 * which gives debounce for free), and never instructs or ranks — it
 * states historical facts.
 */

/** Injection modes (SPEC 2.2): off | lead-only (default) | all. */
export const INJECTION_MODES = ['off', 'lead-only', 'all']

/** Default ceiling for the rendered body (SPEC: ≤200 tokens ≈ 800 chars). */
export const DEFAULT_MAX_TOKENS = 200

/** Rough English token estimate — chars/4 keeps the budget conservative. */
const CHARS_PER_TOKEN = 4

/** Fixed advisory disclaimer — the governance red line, never truncated. */
const DISCLAIMER = 'Historical stats, may be stale, never override current observations.'

const HEADER_LEAD = 'Cross-session trust of agent types you may delegate to:'
const HEADER_TEAMMATE_SELF = 'Your cross-session trust profile:'
const HEADER_TEAMMATE_PEERS = 'Recent trust of your collaborators:'

/**
 * Normalize injection configuration from a profile config value or an
 * environment override. Defensive: any invalid shape falls back to the
 * documented defaults instead of throwing (a bad config must never take
 * the observer half down with it).
 *
 * @param {unknown} raw - a mode string, or `{ mode?, maxTokens? }`.
 * @returns {{ mode: string, maxTokens: number }}
 */
export function normalizeInjectionConfig(raw) {
  const defaults = { mode: 'lead-only', maxTokens: DEFAULT_MAX_TOKENS }
  let source = raw
  if (typeof source === 'string') source = { mode: source }
  if (source === null || typeof source !== 'object') return defaults
  const mode = typeof source.mode === 'string' && INJECTION_MODES.includes(source.mode)
    ? source.mode
    : defaults.mode
  const maxTokens = Number.isFinite(source.maxTokens) && source.maxTokens >= 16
    ? Math.floor(source.maxTokens)
    : defaults.maxTokens
  return { mode, maxTokens }
}

/**
 * One trust row for the summary body: `name: dims…, counters…`.
 * Low-confidence dimensions are labelled; confident ones carry value and
 * sample count. Row order and formatting are deterministic.
 */
function agentRow(agent) {
  const name = agent?.profile?.name ?? 'unknown'
  const dims = []
  for (const dim of ['competence', 'reliability', 'communication', 'integrity']) {
    const rec = agent?.dims?.[dim]
    if (rec === undefined || !Number.isFinite(rec.value) || !Number.isFinite(rec.samples) || rec.samples <= 0) continue
    const label = `${dim} ${rec.value.toFixed(2)}/${rec.samples}`
    dims.push(rec.lowConfidence ? `${label} low-confidence` : label)
  }
  const stats = agent?.stats ?? {}
  const counters = [
    `tasks ${Math.max(0, Number(stats.tasksCompleted) || 0)}`,
    `tools ${Math.max(0, Number(stats.toolCalls) || 0)}/${Math.max(0, Number(stats.toolErrors) || 0)} err`,
    `messages ${Math.max(0, Number(stats.messagesSent) || 0)}`,
  ]
  return `${name}: ${dims.join(', ')}${dims.length > 0 ? '; ' : ''}${counters.join(', ')}`
}

/** An agent has data when any dimension sampled or any counter moved. */
function hasData(agent) {
  for (const dim of ['competence', 'reliability', 'communication', 'integrity']) {
    if ((agent?.dims?.[dim]?.samples ?? 0) > 0) return true
  }
  const s = agent?.stats ?? {}
  return (s.tasksCompleted ?? 0) > 0 || (s.toolCalls ?? 0) > 0 || (s.messagesSent ?? 0) > 0
}

/**
 * Render the L1 trust summary injected as a PromptContext contribution.
 *
 * @param {object} input
 * @param {Array} input.ledgerProjection - dashboard() agent rows (already
 *   sorted lastSeen-desc by the projection itself).
 * @param {{ role: 'lead'|'teammate', name: string } | null} input.membership -
 *   the assembling agent's team membership, or null when the assembly has
 *   no live agent (bare assemble in tests/diagnostics).
 * @param {string} input.mode - normalized injection mode.
 * @param {number} [input.maxTokens] - body budget before truncation.
 * @returns {string} the contribution text; '' contributes nothing.
 */
export function renderTrustContext({ ledgerProjection, membership, mode, maxTokens = DEFAULT_MAX_TOKENS }) {
  if (membership === null || typeof membership !== 'object') return ''
  if (mode === 'off') return ''
  const agents = Array.isArray(ledgerProjection)
    ? ledgerProjection.filter((a) => a && typeof a === 'object' && hasData(a))
    : []
  const isLead = membership.role === 'lead'
  if (mode === 'lead-only' && !isLead) return ''

  const selfName = typeof membership.name === 'string' ? membership.name : ''
  let header
  let rows
  if (isLead) {
    header = HEADER_LEAD
    rows = agents.filter((a) => (a?.profile?.name ?? '') !== selfName)
  } else {
    const self = agents.filter((a) => (a?.profile?.name ?? '') === selfName)
    const peers = agents.filter((a) => (a?.profile?.name ?? '') !== selfName)
    if (self.length === 0 && peers.length > 0) {
      // Untracked teammate: no self profile yet — show collaborators under
      // the peer header only (plain rows; the header already announces them).
      header = HEADER_TEAMMATE_PEERS
      rows = peers
    } else {
      header = HEADER_TEAMMATE_SELF
      rows = self.length > 0 && peers.length > 0
        ? [...self, { __peerHeader: true }, ...peers.map((a) => ({ ...a, __peer: true }))]
        : [...self, ...peers]
    }
  }
  if (rows.length === 0) return ''

  // Budget: keep the disclaimer whole, drop the oldest-seen rows from the
  // tail when the body exceeds it (projection is lastSeen-desc, so the tail
  // is the stalest).
  const budgetChars = Math.max(64, Math.floor(maxTokens * CHARS_PER_TOKEN))
  const lines = []
  for (const row of rows) {
    if (row.__peerHeader === true) continue
    lines.push({ text: agentRow(row), peer: row.__peer === true })
  }
  let peerHeaderUsed = false
  const accepted = []
  for (const line of lines) {
    if (line.peer && !peerHeaderUsed) { peerHeaderUsed = true; accepted.push(HEADER_TEAMMATE_PEERS) }
    accepted.push(line.text)
    if (accepted.join('\n').length > budgetChars) {
      // Drop this line; if it was the first peer row, drop the peer header too.
      accepted.pop()
      if (line.peer && accepted[accepted.length - 1] === HEADER_TEAMMATE_PEERS) accepted.pop()
      break
    }
  }
  if (accepted.length === 0) return ''
  const body = accepted.join('\n')

  return `${header}\n${body}\n${DISCLAIMER}`
}
