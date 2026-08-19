---
name: self-snapshot
description: 需要快速确认 Kimi ignition 当前运行时是否健康时使用：返回 cwd、.dynplugins 记录、goal/memo/agents、smoke 装载状态和 .memo/memo.json 文件概况的最小快照。
---
# self-snapshot

调用：`self_snapshot()` 或技能入口 `run()`。依赖 ipython 内核里的 host 反向桥与本地 .dynplugins/.memo 文件。
