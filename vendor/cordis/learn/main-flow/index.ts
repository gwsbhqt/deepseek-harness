// 主流程精简版（仅供学习）：已移除全部容错/兼容逻辑与对应注释，原始完整版见 ../../src/index.ts
/** Context 类型（插件共享的服务容器）与根 Context 的实现。 */
export * from './context.ts'
/** 事件总线、五种事件派发模式，以及事件相关的类型补充声明。 */
export * from './events.ts'
/** 插件 Fiber 的生命周期状态机、effect 托管原语，以及配置校验辅助。 */
export * from './fiber.ts'
/** 日志门面、日志服务本体，以及日志消息、导出器、格式化相关的类型。 */
export * from './logger.ts'
/** 插件注册表、依赖注入机制，以及插件入口的类型定义。 */
export * from './registry.ts'
/** Service 基类（所有服务的公共父类）与服务生命周期用的符号常量。 */
export * from './service.ts'
/** 供 Context、各服务与插件 Fiber 共用的内部工具函数。 */
export * from './utils.ts'
