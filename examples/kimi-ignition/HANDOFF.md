# kimi-ignition 交接文档（HANDOFF）

> 写给接手的 agent：这是一个**已经点火成功的自进化 harness**。k3（Kimi k3-256k 模型）跑在
> deepseek-harness 的 cordis 插件树上，能自我修改、自我造工具、自驱动迭代。
> 本文档事无巨细记录现状、操作手法、踩过的坑和下一步。读完后先读
> `examples/kimi-ignition/SELF.md`（k3 给自己写的文档）和 `AGENTS.md`（实验室约定+路线图）。
>
> 交接时间：2026-08-19 15:40 左右。交接原因：kimi-ignition 保持 Kimi 模型（省额度给它），
> 宿主编排 agent 从 pa 换成另一家。

---

## 0. 一分钟版

- 实例跑在 **rmux 会话 `kimi-ignition`**（宿主 macOS，cwd=`examples/kimi-ignition`）。
- 跟它说话：`rmux send-keys -t kimi-ignition -l '中文消息'` + 单独发 `Enter`。
- 读它屏幕：`rmux capture-pane -p -t kimi-ignition -S -30`。
- 它有自己的持久 Python 内核（ipython 工具）、持久工人编排（subagent）、自我修改工具（cordis_*）、
  自驱动目标回路（goal）、自动上下文压缩（compaction）、动态插件持久化（dynpersist）。
- 它已经给自己造了 5 个 Python 技能（skills/）、一套 memo 记忆、smoke 自检、REPL 渲染层。
- 所有进展已提交到 `kimi-ignition` 分支（origin = github.com:gwsbhqt/deepseek-harness.git）。

---

## 1. 运行实况（交接时）

- 宿主进程：`node --import tsx ../../vendor/cordis/bin.js`（在 rmux 会话里，tsx 从源码跑）
- IPython daemon：独立 Python 进程（socket `.ipython/daemon.sock`），主 agent 内核=`ignition-main`
- 会话：86 回合 / 351 次真实工具调用 / 上下文 ~53K tokens（256K 窗口，压缩机制在岗）
- 动态插件运行中：`self-2`（memoPad/self_status/subagent_start 桥）、`prule-1`（self:evolution 提示词小节）
- 目标状态：三个阶段目标全部 complete，当前无活动目标（待机，等投喂）
- 技能：`skills/{smoke, self-snapshot, git-tools, subagent, explore}`（prime 契约布局，全部验过）

## 2. 文件地图（examples/kimi-ignition/）

| 文件 | 作用 |
|---|---|
| `cordis.yml` | **白名单组合**（10 意群），系统的"基因组"。改它=热更新（小步安全） |
| `plugin-repl.ts` | 终端接入（k3 自己重写过，四类区分+折叠渲染）。零会话状态，热重载只换皮 |
| `plugin-ipython-daemon.py` | 内核 daemon：具名持久内核、技能装载、snapshot/restore、host 反向桥。主线程=执行器（SIGINT 杀 cell 不杀内核） |
| `plugin-ipython-kernel.ts` | ctx.ipython Service：daemon 薄客户端、惰性重连、断线自愈拉起、registerHostMethod 注册表 |
| `plugin-ipython-tool.ts` | ipython 工具（模型面）+ 内核使用提示词 + host.echo 自检 |
| `plugin-ipython-bridge-subagent.ts` | host.subagent_spawn/list/send/interrupt/report 五原语（与 dsh 工具面 1:1） |
| `plugin-dynpersist.ts` | 动态插件持久化：旁听 session/event 落盘 .dynplugins/，重启/重挂时回放（幂等+冲突退休） |
| `plugin-goal-keeper.ts` | 重启后自动重新武装活动目标（dsh-goal 的 activation 是进程内状态，不补防自循环就停） |
| `plugin-diagnose.ts` | 诊断脚手架（当前未挂白名单；需要时加条目热挂载） |
| `SELF.md` | **k3 给自己写的使用者文档**（能力清单/持久化地图/自检/踩坑），它自己维护 |
| `AGENTS.md` | 实验室约定 + 路线图 + 重启存活矩阵 |
| `skills/<名>/` | k3 自造的 Python 技能（prime 契约：SKILL.md+pyproject.toml+src/<import名>/__init__.py） |
| `.sessions/` `.ipython/` `.dynplugins/` `.memo/` `.repl-backup/` | 运行时产物（gitignored，.memo/memo.json 也 ignore；smoke.py 已毕业到 skills/） |
| `.goal-objective*.txt` | 历史目标全文（长文本走文件通道的实证） |

## 3. cordis.yml 意群结构（白名单全图）

1. 开发基建：logger-console / timer / hmr
2. LLM 缝：dsh-llm + dsh-llm-pi-ai（**kimi-coding 路由，模型 k3-256k**，endpoint api.kimi.com/coding，anthropic-messages 协议，256K 窗口）
3. 记忆：dsh-session + dsh-session-persistence-jsonl（.sessions/ 落盘）
4. 脑：dsh-system-prompt（persona）+ dsh-tools + dsh-agent + dsh-agent-loop（agents: [{id: main, sessionId: ignition-main, provider: kimi-coding, model: k3-256k, cwd: 仓库根}]）
5. 自我修改：dsh-tool-cordis + dsh-cordis-host-runner + plugin-dynpersist
6. 多 agent 编排：dsh-session-projection + dsh-subagent + spawn-in-process + tool-subagent/control/report（**continuable 模式，工人用同款 Kimi 脑**）
7. IPython：plugin-ipython-kernel + plugin-ipython-tool + plugin-ipython-bridge-subagent
8. 自驱动：dsh-goal（defaultMaxGoalRounds: 64）+ dsh-tool-goal + dsh-goal-round-driver + plugin-goal-keeper
9. 上下文代谢：token-meter + compaction-basic（thresholdRatio 0.75 自动压缩，实测 212K→26K）
10. 入口：plugin-repl

## 4. 操作手册（接管者必读）

### 4.1 遥控手势
```bash
rmux send-keys -t kimi-ignition -l '消息文本'   # 中文必须 -l
rmux send-keys -t kimi-ignition Enter            # Enter 单独发
rmux capture-pane -p -t kimi-ignition -S -30     # 读屏幕（-S -N 翻历史）
```
- **长消息必碎**：send-keys 长文会碎行，k3 会把碎片误读成多条指令。超过约 200 字 / 含复杂结构的指令，
  **写文件到 examples/kimi-ignition/ 下，让它用 ipython 读**（goal-objective 文件就是这么传的）。
- Enter 偶尔丢失：发完看一眼 pane，消息没变成 `你 ›` 前缀渲染就补发 Enter。

### 4.2 重启 / 恢复
```bash
# 在 rmux 会话里 Ctrl-C 后：
fish -lc 'node --import tsx ../../vendor/cordis/bin.js'
```
重启后自动复活：会话日志（含目标）→ dynpersist 回放动态插件 → memo 从 .memo/memo.json 恢复 →
Python 内核不死（daemon 独立进程）。目标若在活动中，goal-keeper 2 秒后自动补防续跑。

### 4.3 验证纪律（防编造，重要！）
**别信 k3 的口头声明，数会话日志的 tool/call 事件**：
`.sessions/--Users-bytedance-project-deepseek-harness--/ignition-main/session.jsonl`，
`tool/call` 事件是真实调用的铁证。k3 有一个已实证的陷阱：**推理重放自锚定**——历史里若有
"想了要调工具但只回了文字"的 thinking，它会模仿这个模式持续编造工具结果（信誓旦旦但一个 tool_use 都没发）。
规避：任务别太琐碎；已污染就换新 sessionId 重开（记忆文件即历史，删之即新生）。

### 4.4 常见故障
| 症状 | 处理 |
|---|---|
| `[agent not ready yet]` | 有插件静默 PENDING（inject 缺服务）。挂 plugin-diagnose 条目看 fiber 全景 |
| execute 超时/连接中断 | daemon 死了——Service 下次 exec 自动拉起（stale socket 自愈已内建） |
| 动态插件不见了 | dynpersist 会自动回放（日志搜 `[dynpersist]`）；记录全在 .dynplugins/ |
| 目标停了 | goal 的 activation 是进程内状态；重启后 goal-keeper 补防；手动=让 k3 update_goal resume |
| 条目改名/大重组热更新失败 | cordis 事务回滚可能留僵尸，直接重启进程（组合是声明式的，重启即正确状态） |

## 5. 架构决策与为什么这么设计

- **一切皆白名单**：没有套餐（agent-spine 被拒），每个插件显式进 cordis.yml。
- **内核在宿主外**：daemon 独立进程 ⇒ 宿主热重载/重启不杀内核。interrupt 用 SIGINT 不用 SetAsyncExc
  （后者打不断 C 层阻塞如 time.sleep）。
- **host 反向桥**：内核 `host.<方法>(*args)` → NDJSON socket → TS 侧 registerHostMethod 注册表。
  原语（subagent 等）必须宿主侧（碰 ctx 服务）；组合层全在 Python 技能。**一方即三方**：
  静态桥插件与 k3 动态插件自建的桥走同一个注册表。
- **技能对齐 prime 契约**：skills/<名>/{SKILL.md,pyproject.toml,src/<import名>/__init__.py}，
  内核创建/reset 自动装载，reload_skills() 热加载，失败收 _skill_errors 不杀内核。
- **dynpersist 走事件流不走服务包壳**：cordis 的 traceable 代理让方法替换不可靠（实测证伪）；
  cordis_define 的完整源码本来就在会话日志里（model-visible ⟺ logged），旁听最干净。
- **窄桥是安全边界**：不做"任意调任何服务"的全通用桥（那等于无沙箱暴露 define 宿主代码）。

## 6. k3 的行为特性（怎么带它）

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

- **IM / Web 接入**（飞书/浏览器接入面进场，plugin-repl 退役）——下一步大件
- **技能系统深化**：技能多起来后考虑 pa 式提示词广告位（当前 list_skills() 够用）
- **多项目多会话**：subagent 工人已是持久会话；rlm 式 fan_out/observe 组合层可以写成 Python 技能
  （subagent.spawn 循环派发 + send 收割）
- dynpersist 消失悬案（见 7.1）

## 9. 提交历史（kimi-ignition 分支，全部已推送）

```
6f2f26682e execute 改名 ipython + dynpersist 回放修复 + explore 技能
de1e779ca5 subagent 技能与 dsh 工具面一一对应（interrupt/report）
a450854ea9 subagent 技能——统一表达层
d3b6953c35 一方即三方——subagent 桥拆为独立插件
acf02f320b git-tools 技能——cell 从 1070 字符降到 21 字符
44debcea78 REPL 四类渲染 + SELF 入口约定
7f42bf1257 k3 亲手重写 REPL 嘴皮
7b1dbe3a09 技能迁移 prime 契约（k3 自愈完成）
25b6d8426f smoke 晋升标准技能
3fdfb1659c Python 技能机制
861c8cd52c 点火成功——三阶段自驱动自进化 + SELF.md
90acda3e56 上下文代谢（compaction）
16182f9cc5 dynpersist 事件驱动 + daemon 自愈
767e606d11 自驱动回路 + 内核编排桥 + goal-keeper
bc36a140ad IPython 内核三件套
c709053f5d subagent 编排五件套
```
（更早：37532d6001 初始 cordis.yml + plugin-repl.ts；c90b7638b2 AGENTS.md）

## 10. 交接 checklist（接手 agent 先做这些）

1. `fish -lc 'pgrep -fl "cordis/bin.js|plugin-ipython-daemon"'` 确认两进程活着
2. `rmux capture-pane -p -t kimi-ignition -S -10` 看现场
3. 发一句 `跑 smoke() 汇报红绿灯` 验证端到端
4. 读 `SELF.md` + `AGENTS.md` + 本文档
5. 数一次 tool/call 建立基线：`jq -c 'select(.type=="tool/call")' .sessions/*/ignition-main/session.jsonl | wc -l`
