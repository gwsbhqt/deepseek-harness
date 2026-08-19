---
name: explore
description: 读源码定位上下文时用：load(path) 把文件注入调用方内核变量，peek(path或变量, needle) 打印命中前后窗口，findall(path或变量, pattern) 做正则全匹配；避免在 cell 里重复 Path/read_text/正则样板。
---

# explore

源码探索小工具。模块级函数，无 run()。

- `explore.load(path) -> str`：读文件进调用方内核 globals，返回变量名（如 `fiber_ts`，冲突自动加后缀）。
- `explore.peek(path_or_var, needle, before=0, after=800)`：按子串定位并打印 `[idx-before, idx+after)` 窗口。
- `explore.findall(path_or_var, pattern) -> list`：`re.findall(pattern, text)`。
