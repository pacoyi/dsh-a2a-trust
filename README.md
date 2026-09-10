# dsh-a2a-trust

**Trust-indexed A2A reputation for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agent teams** — live trust scoring for spawned teammates: a four-dimension EWMA ledger keyed by agent-type fingerprint (cross-session), an append-only audit log, historical backfill, and a Settings dashboard. Read-only by design — trust is a signal, not a constraint.

English | [中文](README.zh.md)

## Why

When a Lead agent spawns teammates, each worker is a fresh session: a teammate that fumbled every tool call last run is indistinguishable from one that shipped cleanly. Nothing remembers how *this kind of agent* performed.

dsh-a2a-trust gives agent teams a reputation memory:

- **Cross-session identity is the agent *type*, not the instance** — `sha256(name ␟ description ␟ provider ␟ context)` from the durable `team/member` snapshot fields. A re-spawned worker inherits its type's history; a renamed prompt starts fresh.
- **Trust is earned slowly and lost fast** — per-dimension asymmetric EWMA: good evidence moves 10%, bad evidence moves 30%. One botched tool call takes three clean calls to repair.
- **Information-injecting governance only** — the plugin observes the `session/event` stream and never blocks, rewrites, or filters agent-to-agent traffic. Nothing about it can break a team run.

## How it works

Four dimensions, each a value in `[0,1]` starting at 0.5, updated from live events:

| Dimension | Evidence (quality) |
|---|---|
| competence | task completed (1.0), tool success (0.8), tool error (0.0) |
| reliability | task completed (1.0) |
| communication | message sent (0.7), response latency: <60s (1.0), <10min (0.5), slower (0.0) |

- Dimensions with fewer than 5 samples are flagged low-confidence and excluded from the total score.
- Every change is appended to `audit.jsonl` **before** the ledger snapshot updates — crash between the two leaves a stale snapshot, never a lost change; rebuild closes the gap.
- On startup, a backfill replays every `session.jsonl.zstd` under `~/.dsh/sessions` in **global event-time order** (per-session mtime cannot express causality — a Lead log's roster events precede every teammate event while its mtime is the latest). Backfill is idempotent per session: restarts append nothing.
- V2/V3 envelope-tolerant parsing: log-only `team/*` shapes are stable across generations; tool-error flags read both spellings (`data.error` and `message.content[0].isError`).

## Install

Requires the `dsh` CLI. Install into a profile (e.g. `web`):

```sh
dsh plugin --profile web add github:pacoyi/dsh-a2a-trust
```

Or from npm (after publish):

```sh
dsh plugin --profile web add dsh-a2a-trust
```

Or from a local checkout:

```sh
git clone https://github.com/pacoyi/dsh-a2a-trust.git
dsh plugin --profile web add file:./dsh-a2a-trust
```

Restart the service, then open **Settings → 信任指数**. The first start backfills trust from your existing session history.

## Data layout

Everything lives in `~/.dsh/dsh-a2a-trust/` (override with `A2A_TRUST_HOME`):

- `audit.jsonl` — append-only, first-class record of every trust change
- `ledger.json` — rebuildable snapshot (atomic tmp→rename writes, one `.bak` generation), guarded by a cross-process PID-aware lock

Delete the directory to reset all trust. Zero runtime dependencies beyond two peerDependencies (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`); persistence is pure Node built-ins.

## Testing

77 tests across five layers: pure-function unit tests (EWMA math, fingerprinting, confidence gates), an event-extractor suite against fixtures distilled from real session logs, storage contract tests (crash injection, lock takeover, replay equivalence), backfill integration over real zstd-compressed logs (idempotency, cross-session accumulation, reverse-mtime causality), and plugin-level integration driving the real `apply()` through a mocked Cordis context.

```sh
npm test
```

## License

MIT
