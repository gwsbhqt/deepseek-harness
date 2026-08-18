#!/usr/bin/env python3
"""
plugin-ipython-daemon —— 持久 Python 内核 daemon，agent 的"手"的宿主。

职责（唯一）：在宿主播进程之外持有一组具名持久 Python 内核（globals 字典）。
宿主播进程热重载/重启都不杀内核；内核只有收到 reset 或 daemon 本身退出才消失。
daemon 自身升级靠 snapshot/restore（每变量独立序列化，不可序列化的点名跳过）。

线程架构（interrupt 精确性所要求的形态）：
  主线程 = 全局唯一执行器。Python 的信号处理器只在主线程点火，SIGINT 只有发给
  主线程才能打断 C 层阻塞（time.sleep/IO）；异步异常（SetAsyncExc）做不到这一点。
  ⇒ 所有内核的所有 cell 都在主线程排队串行执行（stdout 捕获也因此天然安全）。
  连接接受与读取在 daemon 线程；interrupt 操作 = os.kill(自己, SIGINT)。

协议（unix socket + NDJSON，每行一个 JSON 对象，双向）：
  客户端 → daemon：
    {"id": N, "op": "ping"}                                   活性探测
    {"id": N, "op": "exec",     "kernel": K, "code": "..."}   在内核 K 里排队执行 cell
    {"id": N, "op": "interrupt","kernel": K}                  打断 K 正在执行的 cell（杀 cell 不杀内核）
    {"id": N, "op": "reset",    "kernel": K}                  清空 K 的全部变量
    {"id": N, "op": "snapshot", "kernel": K, "path": P}       把 K 的变量序列化落盘到 P
    {"id": N, "op": "restore",  "kernel": K, "path": P}       从 P 恢复变量进 K
  daemon → 客户端（应答）：{"id": N, "ok": true, ...} 或 {"id": N, "ok": false, "error": {...}}
  daemon → 客户端（反向调用，exec 期间由内核代码发起）：
    {"kind": "host_call", "id": "hc-N", "method": M, "args": [...]}
  客户端 → daemon（反向应答）：{"kind": "host_reply", "id": "hc-N", "ok": bool, "value": ...}

cell 语义（对齐 IPython 手感）：代码按语句编译执行；最后一条语句若是表达式，
其值的 repr 作为 result 返回并绑定到变量 _。stdout/stderr 全量捕获返回。
单客户端假设：任一时刻只服务一条 socket 连接，重连即接管。
"""
import base64
import json
import os
import queue
import signal
import socket
import sys
import threading
import traceback
import types

try:
    import dill as _pickle  # dill 覆盖面广（函数/类/闭包），有则优先
except ImportError:
    import pickle as _pickle


def _log(logf, msg):
    logf.write(f"[ipython-daemon] {msg}\n")
    logf.flush()


class _HostProxy:
    """内核命名空间里的 host 对象：host.<method>(*args) → 反向调用宿主播进程，阻塞等应答。"""

    def __init__(self, kernel):
        object.__setattr__(self, "_kernel", kernel)

    def __getattr__(self, method):
        kernel = object.__getattribute__(self, "_kernel")

        def call(*args):
            return kernel.server.host_call(method, list(args))

        return call


class _Kernel:
    """一个具名内核 = 一个 globals 命名空间。执行统一在 daemon 主线程（见模块 docstring）。"""

    def __init__(self, name, server):
        self.name = name
        self.server = server
        self.namespace = {"__name__": "__main__", "_": None}
        self.namespace["host"] = _HostProxy(self)

    def exec_cell(self, code):
        """执行一个 cell。cell 末尾的孤立表达式的值 = result（并绑定 _）。
        KeyboardInterrupt（interrupt 操作引发的 SIGINT）在此被捕获：死的是 cell，内核存活。"""
        import ast
        import contextlib
        import io

        out, err = io.StringIO(), io.StringIO()
        result_repr = None
        error = None
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                tree = ast.parse(code)
                last = tree.body[-1] if tree.body else None
                if isinstance(last, ast.Expr):
                    head_code = compile(ast.Module(body=tree.body[:-1], type_ignores=[]), "<cell>", "exec")
                    exec(head_code, self.namespace)
                    value = eval(compile(ast.Expression(last.value), "<cell>", "eval"), self.namespace)
                    self.namespace["_"] = value
                    result_repr = repr(value)
                else:
                    exec(compile(tree, "<cell>", "exec"), self.namespace)
            except KeyboardInterrupt:
                error = {"type": "KeyboardInterrupt", "message": "cell 被打断（内核存活）", "traceback": ""}
            except BaseException:
                tb = traceback.format_exc()
                error = {"type": "Error", "message": tb.strip().splitlines()[-1], "traceback": tb}
        return {"stdout": out.getvalue(), "stderr": err.getvalue(), "result": result_repr, "error": error}

    def reset(self):
        self.namespace.clear()
        self.namespace.update({"__name__": "__main__", "_": None, "host": _HostProxy(self)})

    def snapshot(self, path):
        """逐变量序列化落盘；不可序列化的点名跳过并报告（不炸整单）。"""
        saved, skipped = {}, []
        for k, v in self.namespace.items():
            if k in ("host", "__name__") or k.startswith("__"):
                continue
            try:
                saved[k] = base64.b64encode(_pickle.dumps(v)).decode()
            except Exception as exc:
                skipped.append(f"{k} ({exc})")
        with open(path, "w") as f:
            json.dump({"kernel": self.name, "vars": saved}, f)
        return {"saved": sorted(saved), "skipped": skipped}

    def restore(self, path):
        with open(path) as f:
            data = json.load(f)
        restored, failed = [], []
        for k, blob in data["vars"].items():
            try:
                self.namespace[k] = _pickle.loads(base64.b64decode(blob))
                restored.append(k)
            except Exception as exc:
                failed.append(f"{k} ({exc})")
        return {"restored": sorted(restored), "failed": failed}


class _Server:
    def __init__(self, sock_path, log_path):
        self.sock_path = sock_path
        self.kernels = {}
        self.exec_queue = queue.Queue()  # 主线程执行器的任务队列
        self.current_kernel = None  # 主线程正在为谁执行（interrupt 的靶标核对）
        self.conn = None
        self.conn_lock = threading.Lock()
        self.send_lock = threading.Lock()  # 同一连接上的发送互斥（执行完成回调与读取循环并发回包）
        self.pending_host = {}  # host_call id → (Event, 结果 box)
        self.host_seq = 0
        os.makedirs(os.path.dirname(sock_path), exist_ok=True)
        if os.path.exists(sock_path):
            os.unlink(sock_path)
        self.logf = open(log_path, "a")
        self.srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.srv.bind(sock_path)
        self.srv.listen(1)

    def kernel(self, name):
        if name not in self.kernels:
            self.kernels[name] = _Kernel(name, self)
        return self.kernels[name]

    def executor_loop(self):
        """主线程循环：串行消费所有内核的 cell。SIGINT 在此线程点火成 KeyboardInterrupt。"""
        while True:
            try:
                task = self.exec_queue.get()
            except KeyboardInterrupt:
                continue  # 空闲时迟到的 SIGINT（cell 刚好先完成）：无 cell 可杀，丢弃
            if task is None:
                return
            kernel, code, done = task
            self.current_kernel = kernel
            try:
                res = kernel.exec_cell(code)
            finally:
                self.current_kernel = None
            done(res)

    def interrupt(self, kernel):
        # 单执行线程 ⇒ 任一时刻最多一个 cell 在跑；核对靶标内核后发 SIGINT 杀它。
        if self.current_kernel is not kernel:
            return False
        os.kill(os.getpid(), signal.SIGINT)
        return True

    def host_call(self, method, args):
        """主线程（正在执行 cell）里阻塞等待宿主播进程应答反向调用。"""
        self.host_seq += 1
        call_id = f"hc-{self.host_seq}"
        ev = threading.Event()
        box = {}
        self.pending_host[call_id] = (ev, box)
        with self.conn_lock:
            conn = self.conn
        if conn is None:
            del self.pending_host[call_id]
            raise RuntimeError("宿主未连接，host 桥不可用")
        self._reply(conn, {"kind": "host_call", "id": call_id, "method": method, "args": args})
        ev.wait()
        del self.pending_host[call_id]
        if not box.get("ok"):
            raise RuntimeError(f"宿主方法 {method} 失败: {box.get('error')}")
        return box.get("value")

    def handle(self, req):
        """快操作（读取线程内联执行）：除 exec 外的一切。exec 由读取循环投入执行队列。"""
        op = req.get("op")
        if op == "ping":
            return {"ok": True, "kernels": sorted(self.kernels)}
        kernel = self.kernel(req["kernel"])
        if op == "interrupt":
            return {"ok": True, "interrupted": self.interrupt(kernel)}
        if op == "reset":
            kernel.reset()
            return {"ok": True}
        if op == "snapshot":
            return {"ok": True, **kernel.snapshot(req["path"])}
        if op == "restore":
            return {"ok": True, **kernel.restore(req["path"])}
        return {"ok": False, "error": {"type": "BadRequest", "message": f"未知 op: {op}", "traceback": ""}}

    def _reply(self, conn, obj):
        """回包：发给指定连接，发送失败静默丢弃（客户端可能已断）；多线程发送互斥。"""
        with self.send_lock:
            try:
                conn.sendall((json.dumps(obj, ensure_ascii=False) + "\n").encode())
            except OSError:
                pass

    def _reader(self, conn):
        """每条连接的读取循环：读请求 → 快操作内联应答，exec 投入执行队列（完成回调里应答）。
        关键不变量：本循环永不阻塞等 exec 完成——否则 interrupt 会排在 exec 后面饿死。"""
        buf = b""
        while True:
            try:
                chunk = conn.recv(65536)
            except OSError:
                break
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if not line.strip():
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if msg.get("kind") == "host_reply":
                    pend = self.pending_host.get(msg["id"])
                    if pend:
                        pend[1].update(msg)
                        pend[0].set()
                    continue
                if msg.get("op") == "exec":
                    kernel = self.kernel(msg["kernel"])
                    req_id = msg.get("id")
                    def done(res, conn=conn, req_id=req_id):
                        self._reply(conn, {"ok": True, **res, "id": req_id})
                    self.exec_queue.put((kernel, msg["code"], done))
                    continue
                try:
                    resp = self.handle(msg)
                except Exception:
                    resp = {"ok": False, "error": {"type": "Internal", "message": traceback.format_exc().strip().splitlines()[-1], "traceback": traceback.format_exc()}}
                resp["id"] = msg.get("id")
                self._reply(conn, resp)
        with self.conn_lock:
            if self.conn is conn:
                self.conn = None
        try:
            conn.close()
        except OSError:
            pass
        _log(self.logf, "client disconnected")

    def serve(self):
        """接受循环（daemon 线程）；主线程在 main() 里跑 executor_loop。"""
        _log(self.logf, f"listening on {self.sock_path}")
        while True:
            conn, _ = self.srv.accept()
            with self.conn_lock:
                if self.conn is not None:
                    try:
                        self.conn.close()
                    except OSError:
                        pass
                self.conn = conn
            _log(self.logf, "client connected")
            threading.Thread(target=self._reader, args=(conn,), daemon=True).start()


def main():
    # SIGINT 不屏蔽：它是 interrupt 操作的载体，在主线程点火成 KeyboardInterrupt 杀 cell。
    # daemon 本体终止走 SIGTERM（宿主不依赖终端 Ctrl-C——daemon 脱离终端运行）。
    sock_path, log_path = sys.argv[1], sys.argv[2]
    server = _Server(sock_path, log_path)
    threading.Thread(target=server.serve, daemon=True).start()
    server.executor_loop()


if __name__ == "__main__":
    main()
