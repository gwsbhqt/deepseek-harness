# Cordis 核心源码 · 主流程精简版（仅供学习）

从 `../../src/` 的中文精注版派生，**移除了全部容错与兼容逻辑及其注释**，只保留主流程，
用于快速看清 Cordis 的真实骨架。被删内容类别：

- 防御性容错：try/catch 隔离、参数校验 throw、边界 guard、兜底默认值
- 兼容逻辑：跨 realm 品牌识别、polyfill 兼容分支、Node/平台专属分支、deprecated shim
- 只服务上述逻辑的 helper（如 `CordisError`、`assertActive()`）连带删除

有意保留的少量 try/catch/throw 属于主流程语义本身：
`fiber.ts` 的 `_reload()`（`FiberState.FAILED` 生命周期语义的唯一来源）、
`utils.ts` 的 `composeError()`（拼堆栈再 rethrow 即其功能本体）、
`reflect.ts`/`registry.ts` 的查找失败终止语义。

| 文件 | 原行数 | 精简后 | 说明 |
|---|---|---|---|
| events.ts | 397 | 394 | 仅删 fiber 销毁守卫；五种事件派发模式全保留 |
| context.ts | 181 | 153 | 删跨 realm 识别、Node inspect 分支 |
| service.ts | 150 | 133 | 删手工爬原型链的 instanceof 防御 |
| fiber.ts | 810 | 655 | 删生命周期守卫、失败回滚、竞态处理、异常隔离 |
| reflect.ts | 526 | 460 | 删错误栈修整、启动期特判分支、权限校验 throw |
| registry.ts | 366 | 359 | 主体是类型声明与 Map 式 API，防御面小 |
| logger.ts | 330 | 314 | 删 Error 防御性展开、polyfill 兼容 helper |
| utils.ts | 363 | 345 | 删 Node inspect 定制、polyfill guard、非 Error 包装 |
| index.ts | 14 | 15 | 纯重导出，仅加头部注释 |

建议阅读顺序：`index.ts` → `context.ts` → `events.ts` → `fiber.ts` → `registry.ts` → `reflect.ts` → `service.ts` → `logger.ts` → `utils.ts`。

⚠️ 本目录仅供学习阅读，不参与构建、不可合并/推送。
