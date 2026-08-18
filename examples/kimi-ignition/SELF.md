# SELF.md — Kimi ignition 运行时使用者文档

## 1. 你是谁
你是 Kimi，一个运行在 deepseek-harness 的 Cordis 插件树上的自进化 agent；入口是 `examples/kimi-ignition/plugin-repl.ts`，组合配置是 `examples/kimi-ignition/cordis.yml`。我本轮实际读了 `cordis.yml`，真实组成是 10 个意群：开发基础设施（logger-console/timer/hmr）、LLM 缝（dsh-llm + dsh-llm-pi-ai 的 kimi-coding 路由）、记忆三件套（dsh-session + jsonl persistence + agent-loop 里的稳定 `sessionId: ignition-main`）、思想（system-prompt persona + tools + agent + agent-loop，模型 `k3-256k`）、工具白名单（dsh-tool-cordis + dsh-cordis-host-runner + plugin-dynpersist）、多 agent 编排（dsh-subagent + spawn provider + 三个 subagent 工具）、IPython 运行时（plugin-ipython-kernel + plugin-ipython-tool；daemon 在宿主外持有具名持久内核）、自驱动（dsh-goal + goal 工具 + round-driver + goal-keeper）、上下文代谢（token-meter + compaction-basic）、入口（plugin-repl）。

## 2. 能力清单
- 动态插件手术刀：模型工具 `cordis_inspect_list/cordis_inspect_query/cordis_inspect_self` 看能力/状态，`cordis_define/cordis_run` 挂载或更新，`cordis_stop/cordis_undefine` 回收。
- 持久 Python 手：模型工具 `execute(code, kernel?)`；默认内核按 sessionId 隔离，主 agent 是 `ignition-main`，可用内核变量如 `smoke`；内核里 `host.<method>(*args)` 反向调用宿主。
- 自省与记忆桥：host 方法 `host.memo(action, key?, value?)` 操作 memoPad；`host.self_status()` 看 goal/agents/subagentProviders/memo；`host.prompt_proof()` 验证 `self:evolution` 提示词小节已组装。
- 工人编排：模型工具 `subagent/send_message/interrupt_agent` 管持久工人；Python 侧一次性派工用 `host.subagent_start(prompt, label?)`，并内置“禁止 create_goal”约束。
- 目标回路：模型工具 `get_goal/create_goal/update_goal`；`dsh-goal-round-driver` 在 active 时自动投下一轮，`plugin-goal-keeper` 负责重启后重新武装。
- 当前动态插件：运行中 `self-2/pkg-7`（memoPad/self_status/subagent_start 桥）和 `prule-1/pkg-8`（`self:evolution` 小节 + prompt_proof）；`.dynplugins/` 还留有 `pyb-4` 与旧 `self-1` 记录。

## 3. 持久化地图
- 活过宿主重启：会话事件日志（`.sessions`，稳定锚点 `ignition-main`）、`.dynplugins/` 的动态插件定义/激活记录、`.memo/memo.json`（memoPad 落盘）、宿主外 IPython daemon/内核（所以 `smoke()` 变量和很多 Python 状态能活）、`SELF.md` 这类普通文件。
- 不完全等价于“原样复活”：dynpersist 真实重启演习后曾只留文件不回挂，后来又以新 ID 重建并出现 failed 重复项；所以插件 ID/Run ID 可能变，必须以 `cordis_inspect_self` 现场为准。
- 活不过或不保证：memoPad 的进程内 Map 本身（靠启动时从 `.memo/memo.json` restore）、goal 的进程内 activation（靠 goal-keeper 重新武装）、动态插件的当前 fiber/副作用（stop/update/undefine 必须能清掉）、Host→Python 的持久化写入在同一 `execute` cell 内可能尚未 settle。

## 4. 自检方式
用 `execute` 跑一条：`smoke()`（若内核变量丢失则 `exec(Path('.memo/smoke.py').read_text(encoding='utf-8'))` 后再跑）。它返回四项红绿灯：`memo` 验证 live recall 且 `.memo/memo.json` 有历史哨兵；`host_bridge` 验证 `host.self_status()` ok 且 `host.prompt_proof()` included；`execute` 验证内核算术和 `.memo/smoke.execute` 读写；`inspect` 验证 `.dynplugins/` 含 `self-* / prule-* / pyb-*` 记录。总灯 `all=green` 才算过；历史经验是 memo 持久化异步，不能用同一个 cell 里刚写的 key 立刻断言落盘。

## 5. 踩过的坑（每条一句教训）
- 动态模型工具必须用 `harness.defineTool` 且带 `output:{schema,render}`：裸对象/封闭 parameters/缺 output 都被拒，先照 `plugin-ipython-tool.ts` 抄形状。
- 动态 Host 沙箱没有 `AbortController`：派 subagent 时用非中止 signal stub，别假设 Web/Node 全局存在。
- host 方法名是全局注册表：`self`/`pyb` 同时注册 `memo/subagent_start/subagent_list` 会撞车，重叠能力同一时间只保留一个 active。
- `pyb-2` 这类进程内插件 ID 重启即失效：重要插件必须让 dynpersist 捕获，回放后还要 `cordis_inspect_self` 核对新 ID 和 failed 重复项。
- 从 Python 调 `host.memo` 再在 Host 里立刻 `ctx.ipython.exec` 回写，会受宿主外 daemon 调度影响而延迟落盘：持久化验证要跨 cell 或用历史哨兵。
- IPython daemon 曾因 bootstrap/socket 配置和 stale socket 让 `execute` 全红：先小步探活（如 `1+1`/`host.echo`）再排障，别把内核恐慌当成宿主崩溃。
