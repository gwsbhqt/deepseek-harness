# kimi-ignition —— 超级自进化 harness 点火实验室

## 目标

造一个超级 harness，融合三家的核心优势：

- **pa 的 IPython 运行时**：变量常驻的持久内核 + 极简工具面（而非离散的 bash/read/write/edit）。
- **Hermes 的 daemon 形态**：持续运行、技能自进化、记忆持久化、IM 接入。
- **deepseek-harness 的插件化**：一切皆插件，改配置/改代码热重载不停机。

终态：一个拥有 IPython 运行时、daemon 化、harness 自进化、技能自进化、插件自进化、可动态更新自身配置与代码且不停机的实例，可从终端 / IM / Web 三栖接入。

## 路径（已完成 ✅ / 待做 ○）

1. ✅ **第一层点火**：最小 cordis 单元跑通 Kimi（kimi-coding 路由，k3-256k），配置/代码双热重载。
2. ✅ **第二层点火**：白名单组合出完整 agent——脑、记忆（落盘+sessionId 复活）、自我修改执行器、终端入口。
3. ✅ **subagent 编排进场**：意群 6 五件套；continuable 工人是持久可续会话；真委派验真。
4. ✅ **IPython 内核三件套**（意群 7）：daemon 持久内核 + ctx.ipython Service + execute 工具；host 反向桥（host_call 带 kernel 名做调用方鉴权）；编排三件套 host.subagent_spawn/list/send 把 ctx.subagents 递到 Python（rlm 手感的落点）。
5. ✅ **自进化实弹**：k3 自主 cordis_define→cordis_run 迭代四个版本造出 memoPad（KV 便签），当场验证生效。此后又自建 self bridge（host.memo/self_status/prompt_proof）、prule（self:evolution 提示词小节）、smoke 自检仪式。
6. ✅ **自驱动回路**（意群 8）：dsh-goal + goal-round-driver 持续投轮 + plugin-goal-keeper 重启补防。两个目标已自主跑到 complete。
7. ✅ **耐久层**：plugin-dynpersist（动态插件定义落盘 .dynplugins/ + 重启回放，幂等+冲突退休）+ 意群 9 上下文代谢（token-meter + compaction-basic auto，75% 阈值自动压缩，实测 212K→26K）。
8. ○ **IM / Web 接入**：飞书/浏览器接入面进场，plugin-repl 退役。
9. ○ **技能系统**：挂 dsh-skill + 本地 provider，之后技能自进化。

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
- **操控手势**：实例跑在 rmux 会话 `kimi-ignition`；`send-keys -l` 发文本（中文必须 -l）、单独发 Enter、`capture-pane -p` 读输出。
- **effect 纪律**：插件拿外部资源（stdin/进程/定时器）必须 `ctx.effect` 返回卸载器，cordis v4 没有 dispose 事件。
- **k3 推理重放陷阱**：k3-256k 会把重放历史里自己的 thinking 当行为范本——一旦某轮"想了要调工具但只回了文字"，后续轮次会模仿这个模式持续编造工具结果（看起来信誓旦旦，实际一个 tool_use 都没发）。发现之道：会话日志里数 `tool/call` 事件，别信模型的口头声明。规避：不让编造进历史（任务别太琐碎，琐碎任务它会判定"直接答"而跳过工具）；已污染就换新 sessionId 重开（记忆文件即历史，删之即新生）。
- **静默 PENDING 判读**：registry 里服务插件名下的 (anon) PENDING fiber 多为可选集成在等服务（如 dsh-session 等 typert），不是错误；诊断用 plugin-diagnose.ts（脚手架，需要时在 cordis.yml 加条目热挂载）。
