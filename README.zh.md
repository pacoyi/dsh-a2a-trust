# dsh-a2a-trust

**[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agent 团队的信任指数插件** —— 为 spawn 出的 teammate 做实时信任评分：四维 EWMA 信任账本（按 agent 类型指纹跨会话累积）、append-only 审计日志、历史会话回填、设置页看板。只读设计——信任是信号，不是约束。

[English](README.md) | 中文

## 为什么

Lead agent spawn teammate 时，每个 worker 都是一次性新会话：上一轮把工具调用搞砸的 teammate，和干净交付的，这次完全无法区分。没有任何东西记得“这类 agent”过去的表现。

dsh-a2a-trust 给 agent 团队一个声誉记忆：

- **跨会话身份是 agent“类型”，不是“实例”** —— `sha256(name ␟ description ␟ provider ␟ context)`，原料来自 `team/member` 事件的 durable 快照字段。重新 spawn 的 worker 继承该类型的历史；改了 prompt 的配置则从零开始。
- **信任挣得慢、掉得快** —— 每维非对称 EWMA：好证据挪 10%，坏证据挪 30%。一次搞砸的工具调用需要三次干净调用才能修复。
- **只注入信息，不做治理** —— 插件旁路观察 `session/event` 事件流，从不阻塞、改写或过滤 agent 间通信。它不可能弄坏任何团队运行。

## 工作原理

四个维度，各是 `[0,1]` 区间、从 0.5 起步的值，由实时事件驱动：

| 维度 | 证据（质量值） |
|---|---|
| competence 能力 | 任务完成（1.0）、工具成功（0.8）、工具出错（0.0） |
| reliability 可靠 | 任务完成（1.0） |
| communication 沟通 | 发出消息（0.7）、响应延迟：<60s（1.0）、<10min（0.5）、更慢（0.0） |

- 样本数不足 5 的维度标记低置信，不计入总分。
- 每次变更**先**追加 `audit.jsonl` **再**更新账本快照——两步之间崩溃只会留下过期快照，永不丢变更；rebuild 自动补齐。
- 启动时回填 `~/.dsh/sessions` 下全部 `session.jsonl.zstd`，按**全局事件时间序**回放（会话级 mtime 无法表达因果：Lead 日志的 roster 事件因果上先于所有 teammate 事件，但其 mtime 反而最晚）。回填按会话幂等：重启不重复追加。
- V2/V3 双容忍解析：log-only 的 `team/*` 事件形状两代一致；工具错误标志双拼写兼容（`data.error` 与 `message.content[0].isError`）。

## 安装

需要 `dsh` CLI。安装进某个 profile（如 `web`）：

```sh
dsh plugin --profile web add github:pacoyi/dsh-a2a-trust
```

或从 npm（发布后）：

```sh
dsh plugin --profile web add dsh-a2a-trust
```

或从本地检出：

```sh
git clone https://github.com/pacoyi/dsh-a2a-trust.git
dsh plugin --profile web add file:./dsh-a2a-trust
```

重启服务后打开 **设置 → 信任指数**。首次启动会从已有会话历史回填信任数据。

## 数据布局

全部数据在 `~/.dsh/dsh-a2a-trust/`（用 `A2A_TRUST_HOME` 覆盖）：

- `audit.jsonl` —— append-only，每次信任变更的第一公民记录
- `ledger.json` —— 可重建快照（tmp→rename 原子写、保留一代 `.bak`），跨进程 PID 感知锁保护

删除该目录即重置全部信任。除两个 peerDependencies（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`）外零依赖；持久化纯 Node 内建。

## 测试

77 项测试覆盖五层：纯函数单元（EWMA 数学、指纹、置信门控）、基于真实会话日志脱敏 fixture 的事件提取器套件、存储契约（崩溃注入、锁接管、重放等价性）、真 zstd 压缩日志的回填集成（幂等、跨会话累积、反 mtime 因果）、以及 mock Cordis 上下文驱动真实 `apply()` 的插件级集成。

```sh
npm test
```

## 许可

MIT
