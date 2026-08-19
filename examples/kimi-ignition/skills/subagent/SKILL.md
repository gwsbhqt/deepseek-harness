---
name: subagent
description: 在 execute 内核里编排持久工人 agent 时用：把 host.subagent_spawn/list/send 藏进 subagent.spawn/list/send，让 cell 只写 subagent.spawn(...) 这类统一表达，不碰 host.* 细节。
---

# subagent

内核侧工人编排薄封装。模块级函数，无 run()。

- `subagent.spawn(description, prompt)` → `host.subagent_spawn(...)`
- `subagent.list()` → `host.subagent_list()`
- `subagent.send(id, message)` → `host.subagent_send(id, message)`
