"""subagent：把 host.subagent_* 藏成内核里的统一表达。"""

import inspect


def _host():
    """从调用方 cell 帧里取 host 反向桥；技能模块自身不继承 cell 全局。"""
    frame = inspect.currentframe()
    try:
        frame = frame.f_back
        while frame is not None:
            host = frame.f_globals.get("host")
            if host is not None:
                return host
            frame = frame.f_back
        raise RuntimeError("host 反向桥不可用")
    finally:
        del frame


def spawn(description, prompt):
    """派一个持久工人：`host.subagent_spawn(description, prompt)`。"""
    return _host().subagent_spawn(description, prompt)


def list():
    """列出我的工人：`host.subagent_list()`。"""
    return _host().subagent_list()


def send(id, message):
    """给工人续话：`host.subagent_send(id, message)`。"""
    return _host().subagent_send(id, message)


def interrupt(id):
    """打断在跑的工人：`host.subagent_interrupt(id)`。"""
    return _host().subagent_interrupt(id)


def report(text):
    """工人体内上行汇报：`host.subagent_report(text)`；亲代内核一般不调。"""
    return _host().subagent_report(text)
