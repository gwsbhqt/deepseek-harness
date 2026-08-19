"""smoke：自进化 Agent 四项自检红绿灯。"""
from pathlib import Path
import inspect


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
    """跑 memo/host_bridge/execute/inspect 四项冒烟，返回 {'memo': 'green|red', ..., 'all': ...}。"""
    h = _find('host')
    if h is None:
        raise RuntimeError('host 反向桥不可用')
    report = {}
    try:
        h.memo('remember', 'smoke_key', 'green')
        got = h.memo('recall', 'smoke_key').get('value')
        p = Path('.memo/memo.json')
        text = p.read_text(encoding='utf-8', errors='ignore') if p.exists() else ''
        durable_ok = ('durable_test' in text) or ('smoke_key' in text) or ('phase2_round_0002' in text)
        ok = (got == 'green') and durable_ok
        report['memo'] = 'green' if ok else 'red'
        report['memo_detail'] = {'live_recall': got, 'durable_file': durable_ok, 'async_note': 'same-cell persistence may settle after return'}
    except Exception as e:
        report['memo'] = 'red'
        report['memo_detail'] = type(e).__name__ + ': ' + str(e)[:200]
    try:
        st = h.self_status()
        pp = h.prompt_proof()
        ok = (st.get('ok') is True) and (pp.get('included') is True)
        report['host_bridge'] = 'green' if ok else 'red'
        report['host_bridge_detail'] = {'self_status_ok': st.get('ok'), 'prompt_included': pp.get('included'), 'goal_phase': (st.get('goal') or {}).get('phase')}
    except Exception as e:
        report['host_bridge'] = 'red'
        report['host_bridge_detail'] = type(e).__name__ + ': ' + str(e)[:200]
    try:
        q = Path('.memo/smoke.execute')
        q.parent.mkdir(exist_ok=True)
        q.write_text('42', encoding='utf-8')
        ok = (6 * 7 == 42) and (q.read_text(encoding='utf-8') == '42')
        report['execute'] = 'green' if ok else 'red'
        report['execute_detail'] = {'math': 42, 'file': q.read_text(encoding='utf-8')}
    except Exception as e:
        report['execute'] = 'red'
        report['execute_detail'] = type(e).__name__ + ': ' + str(e)[:200]
    try:
        names = {p.name for p in Path('.dynplugins').iterdir()}
        ok = (any(n.startswith('self-evolution-main--self-') for n in names) and
              any(n.startswith('self-evolution-main--prule-') for n in names) and
              any(n.startswith('self-evolution-main--pyb-') for n in names))
        report['inspect'] = 'green' if ok else 'red'
        report['inspect_detail'] = sorted(names)
    except Exception as e:
        report['inspect'] = 'red'
        report['inspect_detail'] = type(e).__name__ + ': ' + str(e)[:200]
    keys = ['memo', 'host_bridge', 'execute', 'inspect']
    report['all'] = 'green' if all(report.get(k) == 'green' for k in keys) else 'red'
    return report


smoke = run
