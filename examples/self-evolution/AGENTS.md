# self-evolution —— 自进化 Agent 实验室

## 目标

构建一个能持续观察自身状态、修改能力、验证结果并持久化有效变化的 Agent。自进化是这个实例的身份；模型供应商只是可替换的运行配置。

- **pa 的 IPython 运行时**：变量常驻的持久内核 + 极简工具面（而非离散的 bash/read/write/edit）。
- **Hermes 的 daemon 形态**：持续运行、技能自进化、记忆持久化、IM 接入。
- **deepseek-harness 的插件化**：一切皆插件，改配置/改代码热重载不停机。

终态：一个拥有 IPython 运行时、daemon 化、记忆持久化和动态插件能力的实例，能用“观察 → 修改 → 验证 → 持久化 → 继续观察”的闭环改进自身，并从终端、IM 和 Web 接入。

## 路径（已完成 ✅ / 待做 ○）

1. ✅ **运行基础**：最小 Cordis 单元接通当前模型路由（`kimi-coding` / `k3-256k`），配置与代码均可热重载。
2. ✅ **完整 Agent**：白名单组合出模型、记忆（落盘 + sessionId 恢复）、自我修改执行器和终端入口。
3. ✅ **subagent 编排进场**：意群 6 五件套；continuable 工人是持久可续会话；真委派验真。
4. ✅ **IPython 内核三件套**（意群 7）：daemon 持久内核 + ctx.ipython Service + execute 工具；host 反向桥（host_call 带 kernel 名做调用方鉴权）；编排三件套 host.subagent_spawn/list/send 把 ctx.subagents 递到 Python（rlm 手感的落点）。
5. ✅ **自进化闭环**：Agent 自主通过 cordis_define→cordis_run 迭代四个版本造出 memoPad（KV 便签），当场验证生效；随后建立 self bridge（host.memo/self_status/prompt_proof）、prule（self:evolution 提示词小节）和 smoke 自检。
6. ✅ **自驱动回路**（意群 8）：dsh-goal + goal-round-driver 持续投轮 + plugin-goal-keeper 重启补防。两个目标已自主跑到 complete。
7. ✅ **耐久层**：plugin-dynpersist（动态插件定义落盘 .dynplugins/ + 重启回放，幂等+冲突退休）+ 意群 9 上下文代谢（token-meter + compaction-basic auto，75% 阈值自动压缩，实测 212K→26K）。
8. ✅ **Web 接入**：Web Host 与 Client 直接挂入当前组合；浏览器、REPL、IPython 和动态插件共用 `self-evolution-main`。
9. ○ **IM 接入**：飞书接入面进场；Web 稳定期间保留 plugin-repl 作为终端回退。
10. ○ **技能系统**：挂 dsh-skill + 本地 provider，之后技能自进化。

## 体系地图（重启存活矩阵）

| 资产 | 载体 | 宿主重启 |
|---|---|---|
| 会话历史/目标状态 | .sessions/*.jsonl（事件溯源） | 活（goal 需 goal-keeper 补防） |
| 动态插件定义 | .dynplugins/*.json → dynpersist 回放 | 活 |
| memoPad 内容 | .memo/memo.json（回放时经 Python 内核恢复） | 活 |
| Python 内核变量 | daemon 独立进程 | 活（daemon 死才丢，可靠 snapshot/restore 自救） |
| 压缩摘要 | 会话日志 compaction/summary 事件 | 活 |

## 工作约定

- **白名单引入**：插件逐条显式进树，没有套餐；模型可见工具 = 谁往 ctx.tools 注册了 schema。
- **id 即插件名**（去 `@deepseek-ai/` scope 前缀）；id 是热重载 diff 的身份证，稳定不改。
- **小步热更新**（改代码/改 config 值）用 hmr；**大重组**（条目 id 变更、整层增减）老实停机重启。
- **人格与工具面同步**：persona 提到的能力必须在白名单里真实存在。
- **记忆三件套**：dsh-session（内存事件日志）→ dsh-session-persistence-jsonl（落盘 ./.sessions）→ agent-loop config 里的稳定 sessionId（复活锚点）。
- **启动分流**：`ds` 保持官方通用 Web（3080）；`dse` 启动或复用 rmux 会话 `self-evolution`，并把当前组合暴露在 3081。
- **操控手势**：优先打开 `http://127.0.0.1:3081`；终端回退用 `send-keys -l` 发文本（中文必须 -l）、单独发 Enter、`capture-pane -p` 读输出。
- **effect 纪律**：插件拿外部资源（stdin/进程/定时器）必须 `ctx.effect` 返回卸载器，cordis v4 没有 dispose 事件。
- **k3 推理重放陷阱**：k3-256k 会把重放历史里自己的 thinking 当行为范本——一旦某轮"想了要调工具但只回了文字"，后续轮次会模仿这个模式持续编造工具结果（看起来信誓旦旦，实际一个 tool_use 都没发）。发现之道：会话日志里数 `tool/call` 事件，别信模型的口头声明。规避：不让编造进历史（任务别太琐碎，琐碎任务它会判定"直接答"而跳过工具）；已污染就换新 sessionId 重开（记忆文件即历史，删之即新生）。
- **静默 PENDING 判读**：registry 里服务插件名下的 (anon) PENDING fiber 多为可选集成在等服务（如 dsh-session 等 typert），不是错误；先查宿主日志与 `cordis_inspect_list`，再查询对应服务和事件。
