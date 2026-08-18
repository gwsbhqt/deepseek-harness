# kimi-ignition —— 超级自进化 harness 点火实验室

## 目标

造一个超级 harness，融合三家的核心优势：

- **pa 的 IPython 运行时**：变量常驻的持久内核 + 极简工具面（而非离散的 bash/read/write/edit）。
- **Hermes 的 daemon 形态**：持续运行、技能自进化、记忆持久化、IM 接入。
- **deepseek-harness 的插件化**：一切皆插件，改配置/改代码热重载不停机。

终态：一个拥有 IPython 运行时、daemon 化、harness 自进化、技能自进化、插件自进化、可动态更新自身配置与代码且不停机的实例，可从终端 / IM / Web 三栖接入。

## 路径（已完成 ✅ / 进行中 🔥 / 待做 ○）

1. ✅ **第一层点火**：最小 cordis 单元（内核+loader+include+hmr）跑通 Kimi（kimi-coding 路由，k3-256k），验证配置/代码双热重载。
2. ✅ **第二层点火**：白名单组合出完整 agent——脑（ReAct 循环）、记忆（落盘+稳定 sessionId 复活）、自我修改执行器（cordis_* 七工具）、终端入口（plugin-repl）。
3. 🔥 **第一次自进化实弹**：让它用 cordis_define/cordis_run 自己写并挂载第一个动态插件，打通"模型写代码 → 沙箱校验 → 运行时挂载 → 当场生效"的闭环。
4. ○ **IPython 内核插件**：持久 Python 内核 + cell 语义。关键决策：内核由 Service 持有（热重载不杀内核），超时杀 cell 不杀内核。
5. ○ **自驱动**：挂 dsh-goal + goal-round-driver，给持续目标，不再等喂话。
6. ○ **IM / Web 接入**：飞书/浏览器接入面进场，plugin-repl 退役。
7. ○ **技能系统**：挂 dsh-skill + 本地 provider，之后技能自进化。

## 工作约定

- **白名单引入**：插件逐条显式进树，没有套餐；模型可见工具 = 谁往 ctx.tools 注册了 schema。
- **id 即插件名**（去 `@deepseek-ai/` scope 前缀）；id 是热重载 diff 的身份证，稳定不改。
- **小步热更新**（改代码/改 config 值）用 hmr；**大重组**（条目 id 变更、整层增减）老实停机重启。
- **人格与工具面同步**：persona 提到的能力必须在白名单里真实存在。
- **记忆三件套**：dsh-session（内存事件日志）→ dsh-session-persistence-jsonl（落盘 ./.sessions）→ agent-loop config 里的稳定 sessionId（复活锚点）。
- **操控手势**：实例跑在 rmux 会话 `kimi-ignition`；`send-keys -l` 发文本（中文必须 -l）、单独发 Enter、`capture-pane -p` 读输出。
- **effect 纪律**：插件拿外部资源（stdin/进程/定时器）必须 `ctx.effect` 返回卸载器，cordis v4 没有 dispose 事件。
