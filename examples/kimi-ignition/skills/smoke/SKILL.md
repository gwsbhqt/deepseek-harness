---
name: smoke
description: 睡前/重启后/改完自进化能力后跑一条自检时使用；检查 memo、host 桥、execute 内核、.dynplugins 记录四项并返回红绿灯 dict。
---
# smoke

调用：`smoke()` 或技能入口 `run()`。`all=green` 才算通过；memo 持久化是异步的，live recall + 历史哨兵才算数。
