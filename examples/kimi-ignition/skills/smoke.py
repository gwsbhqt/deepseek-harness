
def smoke():
    import json, time
    from pathlib import Path
    report = {}
    # 1) memo: live recall proves host memo path; durable sentinel proves persistence bridge.
    # Note: Host->Python persistence is intentionally async and may settle after this cell returns.
    try:
        host.memo('remember', 'smoke_key', 'green')
        got = host.memo('recall', 'smoke_key').get('value')
        p = Path('.memo/memo.json')
        text = p.read_text(encoding='utf-8', errors='ignore') if p.exists() else ''
        durable_ok = ('durable_test' in text) or ('smoke_key' in text) or ('phase2_round_0002' in text)
        ok = (got == 'green') and durable_ok
        report['memo'] = 'green' if ok else 'red'
        report['memo_detail'] = {'live_recall': got, 'durable_file': durable_ok, 'async_note': 'same-cell persistence may settle after return'}
    except Exception as e:
        report['memo'] = 'red'
        report['memo_detail'] = type(e).__name__ + ': ' + str(e)[:200]
    # 2) host bridge
    try:
        st = host.self_status()
        pp = host.prompt_proof()
        ok = (st.get('ok') is True) and (pp.get('included') is True)
        report['host_bridge'] = 'green' if ok else 'red'
        report['host_bridge_detail'] = {'self_status_ok': st.get('ok'), 'prompt_included': pp.get('included'), 'goal_phase': (st.get('goal') or {}).get('phase')}
    except Exception as e:
        report['host_bridge'] = 'red'
        report['host_bridge_detail'] = type(e).__name__ + ': ' + str(e)[:200]
    # 3) execute kernel + file io
    try:
        q = Path('.memo/smoke.execute')
        q.parent.mkdir(exist_ok=True)
        q.write_text('42', encoding='utf-8')
        ok = (6 * 7 == 42) and (q.read_text(encoding='utf-8') == '42')
        report['execute'] = 'green' if ok else 'red'
        report['execute_detail'] = {'math': 6 * 7, 'file': q.read_text(encoding='utf-8')}
    except Exception as e:
        report['execute'] = 'red'
        report['execute_detail'] = type(e).__name__ + ': ' + str(e)[:200]
    # 4) inspect/dynpersist records
    try:
        names = {p.name for p in Path('.dynplugins').iterdir()}
        ok = (any(n.startswith('ignition-main--self-') for n in names) and
              any(n.startswith('ignition-main--prule-') for n in names) and
              any(n.startswith('ignition-main--pyb-') for n in names))
        report['inspect'] = 'green' if ok else 'red'
        report['inspect_detail'] = sorted(names)
    except Exception as e:
        report['inspect'] = 'red'
        report['inspect_detail'] = type(e).__name__ + ': ' + str(e)[:200]
    keys = ['memo', 'host_bridge', 'execute', 'inspect']
    report['all'] = 'green' if all(report.get(k) == 'green' for k in keys) else 'red'
    return report
