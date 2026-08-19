# self-evolution 交接文档（HANDOFF）

> 写给接手的 Agent：这是一个持续运行的自进化 harness。它在 DeepSeek Harness 的 Cordis 插件树上观察、修改、验证并持久化自身能力，也能创建工具和自驱动迭代。当前模型路由是 `kimi-coding` / `k3-256k`，但模型供应商不是实例身份。先读 `examples/self-evolution/SELF.md` 和 `AGENTS.md`，再按本文档接管。

---

## 0. 一分钟版

- 运行 `dse` 启动或复用 **rmux 会话 `self-evolution`**，浏览器入口是 `http://127.0.0.1:3081`；通用 `ds`/3080 保持独立。
- Web 与终端回退访问同一个 `self-evolution-main`；终端发消息用 `rmux send-keys -t self-evolution -l '中文消息'` + 单独发 `Enter`。
- 读它屏幕：`rmux capture-pane -p -t self-evolution -S -30`。
- 它有自己的持久 Python 内核（ipython 工具）、持久工人编排（subagent）、自我修改工具（cordis_*）、
  自驱动目标回路（goal）、自动上下文压缩（compaction）、动态插件持久化（dynpersist）。
- 它已经给自己造了 5 个 Python 技能（skills/）、一套 memo 记忆、smoke 自检、REPL 渲染层。
- 当前工作分支为 `self-evolution`；接管时先检查未提交变更和远端状态。

---

## 1. 运行实况（交接时）

- 宿主进程：`node --import tsx ../../vendor/cordis/bin.js`（在 rmux 会话里，tsx 从源码跑）
- IPython daemon：独立 Python 进程（socket `.ipython/daemon.sock`），主 agent 内核=`self-evolution-main`
- 会话：86 回合 / 351 次真实工具调用 / 上下文 ~53K tokens（256K 窗口，压缩机制在岗）
- 动态插件运行中：`self-2`（memoPad/self_status/subagent_start 桥）、`prule-1`（self:evolution 提示词小节）
- 目标状态：三个阶段目标全部 complete，当前无活动目标（待机，等投喂）
- 技能：`skills/{smoke, self-snapshot, git-tools, subagent, explore}`（prime 契约布局，全部验过）

## 2. 文件地图（examples/self-evolution/）

| 文件 | 作用 |
|---|---|
| `cordis.yml` | **白名单组合**（12 意群），直接包含核心、Web Host 与 Web Client |
| `plugin-repl.ts` | 终端回退（四类区分 + 折叠渲染）。零会话状态，热重载只换皮 |
| `plugin-ipython-daemon.py` | 内核 daemon：具名持久内核、技能装载、snapshot/restore、host 反向桥。主线程=执行器（SIGINT 杀 cell 不杀内核） |
| `plugin-ipython-kernel.ts` | ctx.ipython Service：daemon 薄客户端、惰性重连、断线自愈拉起、registerHostMethod 注册表 |
| `plugin-ipython-tool.ts` | ipython 工具（模型面）+ 内核使用提示词 + host.echo 自检 |
| `plugin-ipython-bridge-subagent.ts` | host.subagent_spawn/list/send/interrupt/report 五原语（与 dsh 工具面 1:1） |
| `plugin-dynpersist.ts` | 动态插件持久化：旁听 session/event 落盘 .dynplugins/，重启/重挂时回放（幂等+冲突退休） |
| `plugin-goal-keeper.ts` | 重启后自动重新武装活动目标（dsh-goal 的 activation 是进程内状态，不补防自循环就停） |
| `SELF.md` | Agent 自己维护的使用者文档（能力清单、持久化地图、自检和已知限制） |
| `AGENTS.md` | 实验室约定 + 路线图 + 重启存活矩阵 |
| `skills/<名>/` | Agent 自造的 Python 技能（prime 契约：SKILL.md+pyproject.toml+src/<import名>/__init__.py） |
| `.sessions/` `.ipython/` `.dynplugins/` `.memo/` `.repl-backup/` | 运行时产物（gitignored，.memo/memo.json 也 ignore；smoke.py 已毕业到 skills/） |
| `.goal-objective*.txt` | 历史目标全文（长文本走文件通道的实证） |

## 3. cordis.yml 意群结构（白名单全图）

1. 开发基建：logger-console / timer / hmr
2. LLM 缝：dsh-llm + dsh-llm-pi-ai（**kimi-coding 路由，模型 k3-256k**，endpoint api.kimi.com/coding，anthropic-messages 协议，256K 窗口）
3. 记忆：dsh-session + dsh-session-persistence-jsonl（.sessions/ 落盘）
4. 脑：dsh-system-prompt（persona）+ dsh-tools + dsh-agent + dsh-agent-loop（agents: [{id: main, sessionId: self-evolution-main, provider: kimi-coding, model: k3-256k, cwd: 仓库根}]）
5. 自我修改：dsh-tool-cordis + dsh-cordis-host-runner + plugin-dynpersist
6. 多 agent 编排：dsh-session-projection + dsh-subagent + spawn-in-process + tool-subagent/control/report（continuable 模式，工人沿用主 Agent 的模型路由）
7. IPython：plugin-ipython-kernel + plugin-ipython-tool + plugin-ipython-bridge-subagent
8. 自驱动：dsh-goal（defaultMaxGoalRounds: 64）+ dsh-tool-goal + dsh-goal-round-driver + plugin-goal-keeper
9. 上下文代谢：token-meter + compaction-basic（thresholdRatio 0.75 自动压缩，实测 212K→26K）
10. 终端回退：plugin-repl
11. Web Host：Typert/API/存储/工作区/WebServer/API Proxy/Web App，直接复用已注册的 `self-evolution-main`
12. Web Client：对话、工具、工作区、Cordis 动态插件面板和只读 Loader 插件清单

## 4. 操作手册（接管者必读）

### 4.1 遥控手势
```bash
dse                                                # 启动或复用自进化 Web
open http://127.0.0.1:3081                         # 浏览器访问同一个活动 Agent
rmux send-keys -t self-evolution -l '消息文本'   # 中文必须 -l
rmux send-keys -t self-evolution Enter            # Enter 单独发
rmux capture-pane -p -t self-evolution -S -30     # 读屏幕（-S -N 翻历史）
```
- 浏览器首次打开可能停在“新会话”；从侧边栏选择已有的 `deepseek-harness` 会话一次即可，选择会被浏览器保存。
- Cordis 面板显示当前会话的动态插件；“设置 → 插件 → 插件列表”显示完整 Loader 树。
- **长消息必碎**：send-keys 长文会碎行，模型会把碎片误读成多条指令。超过约 200 字 / 含复杂结构的指令，
  **写文件到 examples/self-evolution/ 下，让它用 ipython 读**（goal-objective 文件就是这么传的）。
- Enter 偶尔丢失：发完看一眼 pane，消息没变成 `你 ›` 前缀渲染就补发 Enter。

### 4.2 重启 / 恢复
```bash
rmux kill-session -t self-evolution
dse
```
重启后自动复活：会话日志（含目标）→ dynpersist 回放动态插件 → memo 从 .memo/memo.json 恢复 →
Python 内核不死（daemon 独立进程）。目标若在活动中，goal-keeper 2 秒后自动补防续跑。

干净检出首次启动若提示 Web 前端或 `lib/client.js` 不存在，先在仓库根目录执行 `pnpm run build`。

### 4.3 验证纪律（防编造，重要！）
**不要把模型的口头声明当作执行证据；数会话日志的 tool/call 事件**：
`.sessions/--Users-bytedance-project-deepseek-harness--/self-evolution-main/session.jsonl`，
`tool/call` 事件是真实调用的证据。当前模型路由有一个已实证的陷阱：**推理重放自锚定**——历史里若有
"想了要调工具但只回了文字"的 thinking，它会模仿这个模式持续编造工具结果（信誓旦旦但一个 tool_use 都没发）。
规避：任务别太琐碎；已污染就换新 sessionId 重开（记忆文件即历史，删之即新生）。

### 4.4 常见故障
| 症状 | 处理 |
|---|---|
| `[agent not ready yet]` | 有插件静默 PENDING（inject 缺服务）。先查宿主日志，再用 `cordis_inspect_list` 查询对应服务和事件 |
| execute 超时/连接中断 | daemon 死了——Service 下次 exec 自动拉起（stale socket 自愈已内建） |
| 动态插件不见了 | dynpersist 会自动回放（日志搜 `[dynpersist]`）；记录全在 .dynplugins/ |
| 目标停了 | goal 的 activation 是进程内状态；重启后 goal-keeper 补防；手动让 Agent 调用 update_goal resume |
| `dse` 30 秒内未就绪 | 查看命令打印的最近日志；缺 Web/client 产物时先运行 `pnpm run build`，再执行 `dse` |
| 条目改名/大重组热更新失败 | cordis 事务回滚可能留僵尸，直接重启进程（组合是声明式的，重启即正确状态） |

## 5. 架构决策与为什么这么设计

- **一切皆白名单**：没有套餐（agent-spine 被拒），每个插件显式进 cordis.yml。
- **内核在宿主外**：daemon 独立进程 ⇒ 宿主热重载/重启不杀内核。interrupt 用 SIGINT 不用 SetAsyncExc
  （后者打不断 C 层阻塞如 time.sleep）。
- **host 反向桥**：内核 `host.<方法>(*args)` → NDJSON socket → TS 侧 registerHostMethod 注册表。
  原语（subagent 等）必须宿主侧（碰 ctx 服务）；组合层全在 Python 技能。**一方即三方**：
  静态桥插件与 Agent 动态创建的桥走同一个注册表。
- **技能对齐 prime 契约**：skills/<名>/{SKILL.md,pyproject.toml,src/<import名>/__init__.py}，
  内核创建/reset 自动装载，reload_skills() 热加载，失败收 _skill_errors 不杀内核。
- **dynpersist 走事件流不走服务包壳**：cordis 的 traceable 代理让方法替换不可靠（实测证伪）；
  cordis_define 的完整源码本来就在会话日志里（model-visible ⟺ logged），旁听最干净。
- **窄桥是安全边界**：不做"任意调任何服务"的全通用桥（那等于无沙箱暴露 define 宿主代码）。

## 6. 当前模型的行为特性

- **任务别琐碎**：琐碎任务它可能判定"直接答"跳过工具（这就是编造种子）。给真活。
- **内核节俭已教过**：helper 定义一次复用，重复两次晋升技能。它的 cell 已从 1070 字符降到 21 字符。
- **它会自己修东西**：smoke 红灯→自己查源码→发新版本插件修好。给它"自己查一下修好"的空间。
- **探索用 explore 技能**：load/peek/findall（pa 的 find+切片手法的工具化）。
- **git 操作用 git_tools**：status/commit_push 等，不要让它手写 subprocess 样板。
- 它的 memo（host.memo）是它的账本，phase2/phase3/各技能都有记录。

## 7. 已知悬案（未根因）

1. **运行时动态插件神秘消失**（2026-08-19 14:12–15:00 间一次）：疑似 include refresh 级联重挂载
   卸载了 runner 的动态 fiber。dynpersist 回放已兜底，但消失机制没查清。复现路径：多次 yml 编辑
   （加条目/persona 变更）后 cordis_inspect_self 列表为空。
2. **ctx.logger.warn 在本组合不显示**：[I]/[E] 都正常，[W] 从未出现。关键日志请用 info 或 console.log。
3. **hmr 对失败 fiber 的文件变更不重试**：条目挂载失败后改文件不一定触发重挂；
   可靠手势是从 cordis.yml 删掉条目再改回来。

## 8. 路线图（剩余）

- **IM 接入**：飞书接入面进场；Web 已直接挂到活动自进化运行时，plugin-repl 暂作终端回退
- **技能系统深化**：技能多起来后考虑 pa 式提示词广告位（当前 list_skills() 够用）
- **多项目多会话**：subagent 工人已是持久会话；rlm 式 fan_out/observe 组合层可以写成 Python 技能
  （subagent.spawn 循环派发 + send 收割）
- dynpersist 消失悬案（见 7.1）

## 9. 交接 checklist（接手 Agent 先做这些）

1. `dse`，确认返回 `http://127.0.0.1:3081`
2. `fish -lc 'pgrep -fl "cordis/bin.js|plugin-ipython-daemon"'` 确认两进程活着
3. 打开 Web，确认旧会话、Cordis 面板和插件列表可见
4. `rmux capture-pane -p -t self-evolution -S -10` 看现场
5. 发一句 `跑 smoke() 汇报红绿灯` 验证端到端
6. 读 `SELF.md` + `AGENTS.md` + 本文档
7. 数一次 tool/call 建立基线：`jq -c 'select(.type=="tool/call")' .sessions/*/self-evolution-main/session.jsonl | wc -l`
