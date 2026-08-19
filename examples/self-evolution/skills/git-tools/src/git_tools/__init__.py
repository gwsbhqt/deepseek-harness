"""git-tools：deepseek-harness 仓库的结构化 git 助手。

所有函数都只返回 dict（不抛 git 非零退出）：{"ok", "code", "stdout", "stderr"}。
"""

import subprocess

REPO = "/Users/bytedance/project/deepseek-harness"


def _git(*args):
    """跑 `git -C REPO ...`，返回结构化结果。"""
    p = subprocess.run(["git", "-C", REPO, *args], text=True, capture_output=True, timeout=120)
    return {"ok": p.returncode == 0, "code": p.returncode, "stdout": p.stdout, "stderr": p.stderr}


def status():
    """`git status -sb`；返回 {ok, code, stdout, stderr}。"""
    return _git("status", "-sb")


def diff_summary(paths=None):
    """`git diff --stat -- [paths]`；paths 为 None 时看整个工作区。"""
    return _git("diff", "--stat", "--", *(paths or []))


def add(paths):
    """`git add -- <paths...>`；paths 必须是非空字符串列表。"""
    if not paths:
        return {"ok": False, "code": 2, "stdout": "", "stderr": "add(paths) 需要非空 paths"}
    return _git("add", "--", *paths)


def commit(message):
    """`git commit -m <message>`。"""
    return _git("commit", "-m", message)


def current_branch():
    """当前分支名；返回 {ok, code, branch, stdout, stderr}。"""
    r = _git("branch", "--show-current")
    return {**r, "branch": r["stdout"].strip()}


def push(remote="origin", branch=None):
    """`git push <remote> <branch>`；branch 缺省用 current_branch()。"""
    if branch is None:
        b = current_branch()
        if not b["ok"] or not b["branch"]:
            return {"ok": False, "code": 2, "stdout": "", "stderr": f"无法确定当前分支: {b}"}
        branch = b["branch"]
    return _git("push", remote, branch)


def commit_push(message, paths=None, remote="origin", branch=None):
    """add(可选)→commit→push 的短链路；返回 {add, commit, push, ok}。"""
    out = {}
    if paths is not None:
        out["add"] = add(paths)
        if not out["add"]["ok"]:
            return {**out, "ok": False}
    out["commit"] = commit(message)
    if not out["commit"]["ok"]:
        return {**out, "ok": False}
    out["push"] = push(remote=remote, branch=branch)
    return {**out, "ok": out["push"]["ok"]}


_ACTIONS = {
    "status": status,
    "diff_summary": diff_summary,
    "add": add,
    "commit": commit,
    "current_branch": current_branch,
    "push": push,
    "commit_push": commit_push,
}


def run(action="status", **kwargs):
    """按 action 分发 git 助手。

    Args:
        action: status/diff_summary/add/commit/current_branch/push/commit_push 之一。
        **kwargs: 透传给对应函数，如 commit_push(message, paths=None, remote='origin', branch=None)。

    Returns:
        dict: 对应动作的结构化结果。
    """
    if action not in _ACTIONS:
        return {"ok": False, "code": 2, "stdout": "", "stderr": f"未知 action: {action}", "actions": sorted(_ACTIONS)}
    return _ACTIONS[action](**kwargs)
