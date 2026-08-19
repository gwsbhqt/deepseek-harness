"""self_snapshot：返回自进化 Agent 当前运行时最小状态快照。"""
from pathlib import Path
import inspect
import os


def _find(name):
    """从调用栈找 execute 内核命名空间里的对象（技能模块自身不带 host 全局）。"""
    frame = inspect.currentframe()
    try:
        while frame:
            if name in frame.f_globals:
                return frame.f_globals[name]
            if name in frame.f_locals:
                return frame.f_locals[name]
            frame = frame.f_back
    finally:
        del frame
    return None


def run():
    """返回 dict：cwd、dynplugins、goal_phase、memo、agents、smoke_loaded、memo_file。"""
    h = _find('host')
    if h is None:
        raise RuntimeError('host 反向桥不可用')
    snap = {'cwd': os.getcwd()}
    dyn = Path('.dynplugins')
    snap['dynplugins'] = sorted(p.name for p in dyn.iterdir()) if dyn.exists() else []
    try:
        st = h.self_status()
        snap['goal_phase'] = (st.get('goal') or {}).get('phase')
        snap['memo'] = st.get('memo')
        snap['agents'] = st.get('agents')
    except Exception as e:
        snap['host_error'] = type(e).__name__ + ': ' + str(e)[:200]
    snap['smoke_loaded'] = callable(_find('smoke'))
    memo_file = Path('.memo/memo.json')
    snap['memo_file'] = {'exists': memo_file.exists(), 'bytes': memo_file.stat().st_size if memo_file.exists() else 0}
    return snap


self_snapshot = run
