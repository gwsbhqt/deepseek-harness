"""self_snapshot：汇总 Kimi ignition 当前运行时的最小状态快照。"""
from pathlib import Path
import os


def self_snapshot():
    """返回当前运行时快照。

    字段：cwd、.dynplugins 记录、host.self_status 里的 goal/memo/agents、smoke 是否已装载、
    .memo/memo.json 文件存在性与大小。调用方式：在 execute 内核里执行 `self_snapshot()`。
    """
    snap = {'cwd': os.getcwd()}
    dyn = Path('.dynplugins')
    snap['dynplugins'] = sorted(p.name for p in dyn.iterdir()) if dyn.exists() else []
    try:
        st = host.self_status()
        snap['goal_phase'] = (st.get('goal') or {}).get('phase')
        snap['memo'] = st.get('memo')
        snap['agents'] = st.get('agents')
    except Exception as e:
        snap['host_error'] = type(e).__name__ + ': ' + str(e)[:200]
    snap['smoke_loaded'] = callable(globals().get('smoke'))
    memo_file = Path('.memo/memo.json')
    snap['memo_file'] = {'exists': memo_file.exists(), 'bytes': memo_file.stat().st_size if memo_file.exists() else 0}
    return snap
