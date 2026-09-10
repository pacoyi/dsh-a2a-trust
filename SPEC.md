# dsh-a2a-trust SPEC（维护者规格文档）

> 本文件是插件的需求与实现规格记录：需求背景、功能规格、信任模型、技术实现、风险对策与里程碑，供长期维护参考。
> 面向维护者，包含实现细节与设计决策的完整脉络；用户向文档以 README.md / README.zh.md 为准（发布时补写）。
>
> **插件定位**：基于信任指数的 Agent-to-Agent 声誉插件——观察 agent-team 内 Agent 间的协作事件流，持续积累、双向更新跨会话信任指数，让 Lead 派活有依据、 teammate 淘汰有信号、团队协作有可回放的信任审计日志。
>
> **治理哲学**：信息注入型治理——信任是**建议信号**，不是硬约束。插件绝不替模型做决策、绝不改写 Agent 间通信内容、绝不强制拓扑；这与 dsh "harness 不越位" 的核心理念一致。

## 1. 需求背景

### 1.1 问题（四个真实痛点）

dsh agent-team（实验性 Agent 团队子系统）当前是一组**无记忆的协作原语**：邮箱（持久队列 + at-least-once 投递）、任务板（CAS + DAG 校验）、名册（成员生命周期）都工作得很好，但协作质量完全没有信号回路：

1. **Lead 盲选**——`spawn_teammate` 派活时，Lead 对候选 teammate 的历史表现一无所知。上次把任务搞砸的 agent 定义，这次换个会话照样被委以重任。
2. **低质量 teammate 无法淘汰**——没有声誉信号，团队里"混子" agent（工具调用全错、消息从不回）与"骨干" agent 在 Lead 眼里完全等价，只能靠人肉观察会话日志才能发现。
3. **返工循环无信号**——任务失败→重派→再失败的循环没有任何统计沉淀，同类错误跨会话反复出现。
4. **一次性团队无记忆**——每个 Root Session 是一支全新团队，上次协作中积累的"谁擅长什么"全部清零。

### 1.2 目标用户

- 用 dsh agent-team 跑多 Agent 协作任务、跨会话反复使用同一批 teammate 定义（相同 name + description + provider）的开发者
- 研究多 Agent 系统自组织与声誉机制的工程师/研究者（RepuNet 类课题的工程落地）

### 1.3 生态与学术现状（2026-09 时点，均已核实）

- **dsh 官方 A2A 立场**：官方笔记 `2026-06-21-subagent-capability-seam` 明确 "A2A 仍是未来的兄弟传输方式"——传输层（跨进程 Agent 互联）是官方预留位、当前未实现；**信任治理层完全没有官方计划**，是纯插件机会。两层正交：本插件先做本地团队内的信任治理，A2A 传输落地后天然延伸为远端信任查询（见 L4）。
- **A2A 协议**：2026-08-20 已由 Google 移交 Linux Foundation 旗下 AAIF，首年 150+ 组织参与；与 MCP 互补（MCP=agent→tool，A2A=agent→agent）。A2A 时代卡位：谁先有可迁移的信任账本，谁定义 Agent 间的声誉原语。
- **学术背书 RepuNet**（arXiv:2505.05029）：第一个面向生成式 MAS 的声誉系统，机制（声誉更新 ShapeRepuPeer/Self、gossip 传播、声誉驱动网络演化）与本插件的双向反馈环同构；其实验结论（合作聚类涌现、剥削者被孤立）是本插件 L3 实验的理论预期。
- **官方哲学同构**：dsh `canonical-feedback-log`（2026-09-05 已实现）把人类反馈作为**权威 session 日志事件**（`feedback/record`）而非独立存储——本插件 L2 的 trust_feedback 完全沿用同一哲学：反馈是日志事件、随日志导出回放、不额外造第二套提交关系。
- **官方基建利好**（0.1.5-alpha.1，2026-09-08）：支持动态修改系统提示词不破坏 KV Cache——L1 信任摘要注入成员策略提示词的成本大幅下降。

### 1.4 四项已定设计决策（2026-09-09 拍板，本 SPEC 全文以此为纲）

| # | 决策 | 含义 |
|---|---|---|
| D1 | **跨会话信任持久化** | 信任账本落盘、跨 Session 累积；身份键 = agent 类型指纹（见 3.4），不是 SessionId |
| D2 | **插件名 `dsh-a2a-trust`** | 包名 / 仓库名 / GitHub 远程统一；语义完整（A2A 声誉），不用缩写 dsh-trust |
| D3 | **实时流 + 进日志可观测** | 摄取走 `ctx.on('session/event')` 实时事件流（非离线 JSONL 投影）；每次信任变更写入 append-only 审计日志（audit.jsonl）+ cordis logger + 看板，可回放可 grep |
| D4 | **适配 session-log V3 信封** | 解析层双容忍 V2/V3（0.1.5 已是 V3，本地 0.1.2-rc.1 仍 V2）；见 3.6 |

## 2. 功能规格（L0–L4 分级）

分级即里程碑：每级独立可用、可单独发布；高级别建立在低级别的数据面之上。**L0 是 MVP**。

### 2.0 总原则（贯穿所有级别）

1. **只观察、不拦截**：所有摄取都是旁路监听（session/event 流），不改写、不阻断任何 Agent 间通信。
2. **信任是建议**：任何注入模型上下文的内容都是建议性措辞（"historical cooperation stats suggest…"），非指令性。
3. **一切信任变更可审计**：审计日志是第一公民，账本只是审计日志的投影（可从 audit.jsonl 完整重放重建）。
4. **人在回路**：看板可见、账本可人工检查与重置；L2+ 软反馈可被用户关掉。

### 2.1 L0 观察者（MVP）——实时信任时序 + 看板

**输入**：`ctx.on('session/event')` 实时事件流（含 team/* 与 tool/*、step/* 全类型）+ `ctx.on('agent/status')`。

**处理**：从硬指标事件流提取四维信任证据（无 LLM 参与，零 token 成本），按 3.3 计算模型更新账本。

**输出**：
- **持久账本** `~/.dsh/dsh-a2a-trust/ledger.json`（crash-safe 原子写）——按 agent 类型指纹索引的四维信任分 + 累计统计 + 截断的历史环
- **审计日志** `~/.dsh/dsh-a2a-trust/audit.jsonl`（append-only）：每次信任变更一行 `{time, session, teamId, kind, subject, observer, dim, delta, before, after, evidence}`——"进日志可观测"的落地
- **控制台日志**：信任显著变化（|Δ| ≥ 阈值）时输出 cordis logger 一行摘要
- **Web 看板**（双半插件的 client 半，设置页「A2A 信任」卡片）：agent 指纹列表 → 单 agent 四维雷达/时序曲线 + 关键事件流；数据经 Typert RPC 从 host 半读取
- **回填工具**（一次性 bootstrap）：扫描 `~/.dsh/sessions/**/*.session.jsonl.zstd` 历史日志重建账本，让看板第一天就有真实数据（现有历史会话中已确认存在 601 事件的团队运行样本）

**L0 硬指标证据映射**（事件 → 维度，全部源码实证）：

| 维度 | 证据事件 | 方向 |
|---|---|---|
| competence 能力 | `team/task` 状态迁移（done/failed）、`tool/call`+`tool/result`（isError、耗时） | 好↑坏↓ |
| reliability 可靠 | `team/message/queued`→`team/message/delivered` 达成率与时延、任务 assigned→终态完成率 | 好↑坏↓ |
| communication 沟通 | `agent/inbox/spliced` 投递 → 下一条 `assistant/message` 的响应时延、消息量对等性（只派活不汇报↓） | 好↑坏↓ |
| integrity 正直 | L0 **无硬原料**——保持 0.5 中性并标注 `insufficient data`；L2 LLM-judge 才有输入 | 冻结 |

### 2.2 L1 建议者——信任摘要注入

- 信任摘要以固定格式段落（≤200 tokens，建议性措辞）注入 teammate / Lead 的策略提示词（`team:policy` 提示词注入接缝，L1 实现时按当时 0.1.x 源码复核注入路径）。
- 刷新时机：任务边界（`team/task` 终态事件）触发，防抖合并；单会话注入次数上限（默认 8）。
- 注入内容三段式：目标 agent 指纹摘要 / 与当前协作对象的近期信任快照 / 免责句（"historical stats, may be stale, never override current observations"）。
- 开关：profile 配置 `a2a-trust.injection: off | lead-only | all`（默认 lead-only）。

### 2.3 L2 反馈者——双向软反馈

- 新工具 `trust_feedback`（模型侧，免审批但全审计）：`{target: <teammate name>, ratings: {competence?, reliability?, communication?, integrity?} ∈ 1..5, comment? ≤500 字符}`。
  - 与官方 `feedback/record` 哲学同构：反馈是事件（进 audit.jsonl），不是独立存储的第二套提交关系。
  - 限频：每 agent 对同一 target 每会话 ≤3 次更新，防互刷。
  - 双向：任务边界后 Lead 评 teammate、teammate 评 Lead 与协作 peer——对称记录，看板可查分歧。
- 新工具 `trust_query`（只读）：查任意 agent 指纹的四维信任 + 近期证据摘要，供模型决策前自查。
- **LLM-as-judge（可选、默认关、用户显式开启）**：对采样的 inter-agent 消息（`user/message{source.kind=team-message}`）做质量评分进 integrity/communication 维度；成本控制：仅采样（默认 10%）或用户手动触发单次评审。

### 2.4 L3 进化者——拓扑影响（实验性）

- Lead 派活时信任已可见（L1）；L3 在此之上做**对照实验**：同任务分别跑"信任加权分配"与"盲选分配"，对比完成率/返工率/时延。
- 任何影响派活的逻辑必须：默认关、开启需用户显式同意、实验数据进审计日志、绝不硬禁止某个 agent 被派活（只调排序权重，SoftRank 不 veto）。

### 2.5 L4 生态位——跨团队与 A2A 远端（远期）

- 账本导出/导入格式（跨机器迁移信任）。
- A2A 传输层落地后（官方 subagent capability seam 的兄弟传输）：远端 agent 的信任查询/通报协议（本地账本作为 A2A reputation 扩展的数据源）。仅在官方 A2A 稳定后启动，不预造协议。

### 2.6 非目标（明确不做）

- **不做通信拦截改写**：不修改、不延迟、不过滤任何 Agent 间消息内容（无此钩子，也不该有）。
- **不做硬性拓扑控制**：不强制解散/禁用 teammate；L3 也只调权重不 veto。
- **不做自动 LLM-judge 常开**：软质量评分默认关，token 成本必须由用户显式接受。
- **不做云同步/网络功能**：账本纯本地文件（同 memory-lite 立场），不外传。
- **不做跨用户/多租户**：单机单用户假设。
- **不预测 A2A 协议**：L4 等官方传输层稳定，不抢跑造协议。
- **不做会话内一次性团队的强制身份连续**：信任语义绑定 agent 类型指纹（诚实语义），不伪装成"同一个 agent 实例"。

## 3. 技术实现

### 3.1 架构总览（三数据面）

```
┌─ 摄取面（host 半，实时旁路）─────────────────────────────┐
│ ctx.on('session/event')  ──┬─> 硬指标提取器（L0）        │
│ ctx.on('agent/status')    ─┤                            │
│ (tools/pre-execute 备用)  ─┴─> 信任引擎（四维 EWMA）      │
└───────────────────────────┬──────────────────────────────┘
                            v
┌─ 持久面 ─────────────────────────────────────────────────┐
│ audit.jsonl (append-only, 第一公民，可重放重建账本)        │
│ ledger.json (投影快照, crash-safe 原子写 + .bak + 文件锁) │
└───────────────────────────┬──────────────────────────────┘
                            v
┌─ 观测面 ─────────────────────────────────────────────────┐
│ cordis logger（显著变化一行摘要）                          │
│ Typert RPC --> client 半看板（设置页「A2A 信任」卡片）      │
│ L1: team:policy 策略提示词注入（建议性段落）               │
│ L2: trust_feedback / trust_query 工具                     │
└──────────────────────────────────────────────────────────┘
```

### 3.2 事件词汇表（全部源码实证，agent-team 0.1.2-rc.1 与上游 0.1.5-alpha.1 逐字节一致）

实时流 `ctx.on('session/event', (session, event))` 可见（先例：mailbox.ts `observeSessionEvent` 同款过滤模式）：

| 事件类型 | 载荷要点 | 用途 |
|---|---|---|
| `team/member` | `{version, teamId, member:{id, name, description, provider, context: fresh\|fork, phase}}` | 成员注册/状态——**身份指纹原料** |
| `team/task` | `{version, teamId, task}` | 任务全生命周期状态机——competence 证据 |
| `team/message/queued` / `team/message/delivered` | 队列与送达 | reliability 证据（达成率/时延） |
| `user/message`（`data.source.kind === 'team-message'`） | `source: {teamId, messageId, …}` | inter-agent 消息实体——沟通行为与 L2 judge 原料 |
| `agent/inbox/spliced` | `{target, start, inserted}` | 邮箱投递——communication 响应时延起点 |
| `tool/call` + `tool/result` | 工具名、isError、耗时 | competence 硬证据 |
| `step/start` / `step/end`、`tool-workflow/agent-start|end` | 轮次与 workflow agent 生命周期 | 指标归因（哪个 agent 的哪一步） |

辅助钩子：`ctx.on('agent/status')`（agent 运行态变化）、`ctx.on('agent/session-start')`（新 agent 起来时的账本预热）。

### 3.3 信任数据模型（四维 + 非对称 EWMA）

**四维**（沿用 2026-09 探讨定稿）：competence 能力 / reliability 可靠 / communication 沟通 / integrity 正直。每维 value ∈ [0,1]，初始 0.5（中性），附 `samples` 计数与 `updatedAt`。

**更新公式**（非对称指数移动平均——挣得慢、掉得快）：

```
T_new = α · evidence + (1 - α) · T_old
α_good = 0.10（良性证据，10 次好行为才显著拉高）
α_bad  = 0.30（劣性证据，3 次坏行为就显著拉低）
evidence ∈ {1.0 好, 0.5 中性, 0.0 坏}（L0 硬指标离散值；L2 软评分线性映射）
```

- 维度独立更新，总分 = 四维加权（默认等权 0.25，配置可调），看板永远分维展示（总分只是导航便利）。
- `samples` 与 `updatedAt` 随行：样本量 < 阈值（默认 5）时看板标 "low confidence"，L1 注入跳过低置信维度。
- 冷启动：新指纹全维 0.5；同会话内快速演化（硬指标事件密度高），跨会话缓慢收敛（EWMA 天然实现两个时间尺度）。

### 3.4 跨会话身份键（D1 的核心——agent 类型指纹）

dsh 的 teammate 是"命名可持续子会话"（TeamId = Root SessionId；SessionId 每次重建都变），**实例身份天然不跨会话**。诚实的跨会话语义是**类型身份**：

```
fingerprint = sha256(name + '\x1f' + description + '\x1f' + provider + '\x1f' + context)
```

- 四个原料全部来自 `team/member` 事件的 `TeamMemberSnapshot`（durable 字段，已实证）。
- 语义：用户在两个会话里 spawn 同名、同描述、同 provider 的 teammate = 同一"agent 类型"，信任累积。
- 修改 description / 换 provider = 指纹变化 = 新条目（旧条目保留，看板显示"疑似改名/换代"提示：比对 name 相同但指纹不同）。
- 账本条目内保存最近一次的 profile 快照（name/description/provider/context/model），供人辨认与看板展示。
- 已知局限（诚实记录）：同名不同义（名字撞车）会被错误聚合——靠 description 参与指纹缓解；看板提供按指纹合并/拆分的人工修正入口（远期，先记录）。

### 3.5 存储设计（memory-lite 已验证模式移植）

目录 `~/.dsh/dsh-a2a-trust/`：

| 文件 | 角色 | 机制 |
|---|---|---|
| `audit.jsonl` | 第一公民：append-only 审计日志 | 每次信任变更一行 JSON；启动时从尾部续写；可整文件重放重建 ledger.json（`rebuild` 维护命令） |
| `ledger.json` | 投影快照 | crash-safe 原子写：临时文件 + rename；写前 `.bak` 备份上一版 |
| `ledger.lock` | 跨进程文件锁 | PID 生存检测 + 陈锁接管（多 profile 并行起服务时防账本撕裂；同 memory-lite storage.js 模式） |

- 账本结构：`{version, updatedAt, agents: {<fingerprint>: {profile, trust{4 维}, stats, history(环形 ≤64), firstSeen, lastSeen}}}`。
- 写入顺序纪律：**先 append audit.jsonl 再原子更新 ledger.json**（审计先行，快照后行——崩溃时宁可快照旧一点，审计不丢）。

### 3.6 V3 信封适配（D4）

- **实时路径不受影响**：`session/event` 派发的是已解析对象，V2/V3 信封差异对消费者透明。
- **回填/离线扫描路径需双容忍**：
  - V3 规范（官方笔记 2026-09-06-v3-canonical-session-envelopes）：message/tool 事件必带 `surfaceOp`（append / replace 区间），`sourceEventSeqs` 引用链；**team/* 属于"仅日志事件"，形状稳定为 `{type, seq, time, data(, ignorable)}`，V2/V3 一致**——信任主原料天然免疫迁移。
  - 解析器规则：统一取 `type/seq/time/data`；`user/message` 读 `data.source.kind === 'team-message'` 判别（V2/V3 字段一致）；`tool/result` 的 isError 判定兼容两代拼写（V3 强制 `data.error` ⇒ `content[0].isError`）；遇 V3 replace 事件按区间覆盖前值（指标提取以最终态为准）。
  - 解压：`.jsonl.zstd` 优先 `child_process` 调系统 `zstd -dc`，Node ≥22.15 检测 `node:zstd` 可用则内置。
- 本地 host 当前 0.1.2-rc.1（V2）、上游 0.1.5（V3）——**双容忍是发布前置条件**，fixture 同时含两代样本。

### 3.7 已验证接缝清单（六挂点，2026-09 源码核查）

| # | 接缝 | 用途 | 级别 |
|---|---|---|---|
| 1 | `ctx.on('session/event')` | 实时事件流摄取（agent-team mailbox 同款先例） | L0 |
| 2 | `ctx.tools.register(defineTool())` | trust_feedback / trust_query 工具注册（memory-lite 先例） | L2 |
| 3 | `team:policy` 提示词注入点 | 信任摘要建议性注入 | L1 |
| 4 | Typert RPC + 双半插件 | 看板数据通道（memory-lite client 半先例） | L0 |
| 5 | Lead 派活影响（排序权重） | 信任加权分配实验 | L3 |
| 6 | subagent capability seam（未来 A2A 兄弟传输） | 远端信任查询 | L4 |

### 3.8 双半插件形态

对齐 memory-lite 已验证的发布结构：

- `package.json`：零 dependencies、零 peerDependencies（v0.1.0 曾声明 `@deepseek-ai/cordis ^4.0.1 + @deepseek-ai/dsh-tools ^0.0.1-rc.1`，发布后实测移除：两个包在代码里零 import——host 半全走 `ctx.inject?.([...])` 运行时注入；且 prerelease 元组上的 caret range 只匹配同一条元组线，`^0.0.1-rc.1` 对 `0.1.x` 线无约束力，干净安装时 npm 反而静默拉入旧代 `dsh-tools@0.0.1-rc.1`）；`dsh.bundle.patch → ./cordis.patch.yml`；client 半注入 settings UI。client 自注册 id 必须等于包名（boot graph row 以包名为 id，stripClientSuffix 只剥尾部 `/client`，无其他映射——由 client-smoke 测试 pin）。
- host 半（`index.js`）：事件摄取、信任引擎、存储、Typert RPC 服务、工具注册。
- client 半（`client.js`）：设置页「A2A 信任」卡片（列表 + 四维时序 + 事件流），经 RPC 读 host 半。
- 开发循环：`link:` 进 profile + 手工 symlink 到共享池（`~/.dsh/profiles/node_modules/@deepseek-ai/`）——陷阱已知：插件目录内跑 `pnpm install` 会因 dsh-type-meta 404 失败，依赖永远装进 profile。

### 3.9 风险与对策

| 风险 | 对策 |
|---|---|
| 评分者悖论（宽严不一） | L2 软反馈与 L0 硬指标双轨并行；看板展示 hard/soft 分歧告警；双向对称记录天然提供交叉验证 |
| Goodhart（为分而做） | 信任仅建议信号；L3 只调权重不 veto 且需对照实验；注入措辞明确 "never override current observations" |
| 反馈成本（token） | L0 全自动零 token；L1 注入 ≤200 tokens 有上限；LLM-judge 默认关 + 采样 |
| 身份漂移（改名/换描述） | 指纹含 description+provider，变化即新条目；看板"疑似换代"提示；人工合并/拆分远期 |
| 互刷操纵 | 限频（每对 ≤3/会话）+ 双向对称 + 审计日志模式可查 + hard/soft 分歧告警 |
| 数据隐私 | 账本纯本地、无网络功能；审计日志含协作内容摘要——卸载即留文件可人工删除 |

### 3.10 测试策略

- `test/storage.test.js`：原子性（崩溃注入）、锁接管、audit 重放重建账本等价性（仿 memory-lite 双车道）。
- `test/projection.test.js`：事件 → 指标 → 信任更新的纯函数测试；fixture 用真实历史会话脱敏片段（已采集 601 事件团队运行样本：team/task×14、agent/inbox/spliced×11、tool/call×20 等）。
- `test/v3.test.js`：V2/V3 双信封解析（同事件两代拼写 → 同指标）。
- e2e（本地，不进 CI）：profile 起服务 → 两 teammate 协作任务 → 看板出信任时序 → 审计日志可 grep。

### 3.11 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M0 ✅ | 仓库 + 本 SPEC | — |
| M1 (L0) | 实时摄取 + 信任引擎 + 账本/审计 + 看板 + 回填 | 跑一个真实团队任务，看板显示四维时序，audit.jsonl 可重放重建账本 |
| M2 (L1) | 策略提示词注入 | 注入段落出现在 teammate 上下文，措辞建议性，成本 ≤200 tokens |
| M3 (L2) | trust_feedback/trust_query + 可选 judge | 双向反馈进审计日志；限频生效 |
| M4 (L3) | 拓扑对照实验 | 实验报告：信任加权 vs 盲选 |
| M5 (L4) | 等官方 A2A 稳定 | — |

---

## 维护备忘

- 上游升级关注点：`agent-team/src/{journal,types,mailbox,activity}.ts` 于 0.1.5-alpha.1 与本地 0.1.2-rc.1 逐字节一致（2026-09-09 经 GitHub API 核验）；下次同步后重跑 `git diff` 复核这四个文件，若变更则 3.2 词汇表与 3.4 指纹原料需更新。
- 本地 host 仓库 `apps/web/tsconfig.json` 已设 skip-worktree（tests/local 排除），不影响本插件。
- 插件开发规范遵循：SPEC.md 随仓库公开入库（memory-lite 先例）；入库前跑敏感信息扫描（密钥/本机路径/个人邮箱/内网地址）。
- Git 纪律：commit/push 前置条件 = 全部测试通过 + 端到端验证 + 用户人工批准，缺一不可。
