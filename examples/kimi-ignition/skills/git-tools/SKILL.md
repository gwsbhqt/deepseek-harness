---
name: git-tools
description: 仓库 git 常用操作的结构化封装：status/diff_summary/add/commit/push/commit_push；固定操作 /Users/bytedance/project/deepseek-harness，返回 {ok,code,stdout,stderr} 风格 dict，避免在 cell 里重复 subprocess 样板。
---

# git-tools

在 execute 内核里复用的 git 助手。默认仓库根写死为 deepseek-harness；所有动作返回结构化 dict，不抛异常（除参数错误）。

- `git_tools.status()`：`git status -sb`
- `git_tools.diff_summary(paths=None)`：`git diff --stat -- [paths]`
- `git_tools.add(paths)`：`git add -- <paths...>`
- `git_tools.commit(message)`：`git commit -m <message>`
- `git_tools.push(remote='origin', branch=None)`：branch 缺省取当前分支
- `git_tools.commit_push(message, paths=None)`：paths 给定则先 add，再 commit，再 push；返回每一步结果
- `git_tools(action='status', **kwargs)` / `git_tools.run(...)`：按 action 分发到上面函数
