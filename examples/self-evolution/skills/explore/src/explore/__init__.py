"""explore：读源码的正确姿势（load/peek/findall）。"""

import inspect
import re
from pathlib import Path


def _caller_globals():
    """返回调用方 cell 的 globals（内核 namespace），而不是技能模块 globals。"""
    frame = inspect.currentframe()
    try:
        frame = frame.f_back
        while frame is not None:
            g = frame.f_globals
            if g.get("__name__") == "__main__" and "host" in g:
                return g
            frame = frame.f_back
        raise RuntimeError("找不到调用方内核 globals")
    finally:
        del frame


def _var_name(path):
    p = Path(path)
    base = (p.stem + ("_" + p.suffix.lstrip(".") if p.suffix else "")) or "text"
    name = re.sub(r"\W", "_", base)
    if not name or name[0].isdigit():
        name = "text_" + name
    g = _caller_globals()
    out, i = name, 2
    while out in g:
        out = f"{name}_{i}"
        i += 1
    return out


def _read(path_or_var):
    g = _caller_globals()
    if isinstance(path_or_var, str) and path_or_var in g:
        return str(g[path_or_var]), f"var:{path_or_var}"
    p = Path(path_or_var).expanduser()
    return p.read_text(encoding="utf-8"), str(p)


def load(path):
    """把文件读进调用方内核变量并返回变量名。"""
    text = Path(path).expanduser().read_text(encoding="utf-8")
    name = _var_name(path)
    _caller_globals()[name] = text
    return name


def peek(path_or_var, needle, before=0, after=800):
    """定位 needle 并打印前后窗口；返回 {source,index}。"""
    text, source = _read(path_or_var)
    idx = text.find(needle)
    if idx < 0:
        print(f"{source}: 未找到 {needle!r}")
        return {"source": source, "index": -1}
    lo = max(0, idx - before)
    hi = min(len(text), idx + after)
    print(f"--- {source} [{lo}:{hi}] idx={idx} ---")
    print(text[lo:hi])
    return {"source": source, "index": idx}


def findall(path_or_var, pattern):
    """正则全匹配列表。"""
    text, _ = _read(path_or_var)
    return re.findall(pattern, text)
