#!/usr/bin/env python3
"""
plugin-ipython-daemon —— 持久 Python 内核 daemon，agent 的"手"的宿主。

职责（唯一）：在宿主播进程之外持有一组具名持久 Python 内核（globals 字典）。
宿主播进程热重载/重启都不杀内核；内核只有收到 reset 或 daemon 本身退出才消失。
daemon 自身升级靠 snapshot/restore（每变量独立序列化，不可序列化的点名跳过）。

线程架构（interrupt 精确性所要求的形态）：
  主线程 = 全局唯一执行器。Python 的信号处理器只在主线程触发，SIGINT 只有发给
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
    {"kind": "host_call", "id": "hc-N", "kernel": K, "method": M, "args": [...]}
    （kernel 字段让宿主方法知道"哪个会话的内核在调"，是按调用方鉴权/路由的依据）
  客户端 → daemon（反向应答）：{"kind": "host_reply", "id": "hc-N", "ok": bool, "value": ...}

cell 语义（对齐 IPython 手感）：代码按语句编译执行；最后一条语句若是表达式，
其值的 repr 作为 result 返回并绑定到变量 _。stdout/stderr 全量捕获返回。
技能机制（对齐 prime-agent 的 python skill 契约）：技能目录（默认 <socket目录>/skills）
下每个含 SKILL.md + pyproject.toml + src/<import名>/__init__.py 的子目录是一个技能；
内核创建/reset 时把各技能 src 挂进 sys.path 并 import 进命名空间，带 run() 的模块
包成可调用（同步 cell 里自动 asyncio.run 等待异步 run）；pyproject dependencies
缺失时自动 pip --target 装进 <socket目录>/skill-deps；装载失败的名字绑成"不可用桩"
（调用即报原始错误）并收进 _skill_errors，不杀内核。reload_skills() 热加载
（已装模块 importlib.reload），list_skills() 返回技能目录。
单客户端假设：任一时刻只服务一条 socket 连接，重连即接管。
"""
import base64
import importlib
import inspect
import json
import os
import queue
import re
import signal
import socket
import subprocess
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


def _parse_skill_md(path):
    """解析 SKILL.md 的 YAML frontmatter（只取 name/description；stdlib 简解析，不引 yaml）。"""
    meta = {}
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return meta
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end > 0:
            for line in text[3:end].splitlines():
                if ":" in line and not line.startswith((" ", "#")):
                    k, _, v = line.partition(":")
                    meta[k.strip()] = v.strip().strip('"').strip("'")
    return meta


def _validate_skill_md(path, dirname):
    """prime frontmatter 规则：name 匹配目录名/合法字符集/≤64；description 必填/≤1024。"""
    meta = _parse_skill_md(path)
    name = meta.get("name", "")
    desc = meta.get("description", "")
    if name != dirname:
        return f'SKILL.md name "{name}" 与目录名 "{dirname}" 不一致'
    if len(name) > 64 or not re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", name):
        return f'name "{name}" 非法（小写字母数字+单连字符，≤64）'
    if not desc:
        return "SKILL.md 缺 description（prime 契约：缺失即静默不可装载）"
    if len(desc) > 1024:
        return "description 超 1024 字符"
    return None


class _CallableSkillModule(types.ModuleType):
    """带 run() 的技能模块包装：模块本身可调用（同步 cell 里自动等异步 run 完成）。"""

    def __call__(self, *args, **kwargs):
        result = self.run(*args, **kwargs)
        if inspect.isawaitable(result):
            import asyncio
            return asyncio.run(result)
        return result


def _wrap_callable_module(module):
    run = getattr(module, "run", None)
    if not callable(run) or isinstance(module, _CallableSkillModule):
        return module
    wrapped = _CallableSkillModule(module.__name__)
    wrapped.__dict__.update(module.__dict__)
    try:
        wrapped.__signature__ = inspect.signature(run)
    except (TypeError, ValueError):
        pass
    doc = getattr(run, "__doc__", None)
    if doc:
        wrapped.__doc__ = doc
    sys.modules[module.__name__] = wrapped
    return wrapped


class _UnavailableSkill:
    """装载失败的占位桩：调用即抛出原始导入错误（对齐 prime 的不可用技能语义）。"""

    def __init__(self, name, error):
        self.__name__ = name
        self._error = error
        self.__doc__ = f"技能 {name} 不可用: {error}"

    def __call__(self, *args, **kwargs):
        raise RuntimeError(f"技能 {self.__name__} 不可用（装载失败）: {self._error}")

    def __repr__(self):
        return f"<不可用技能 {self.__name__!r}: {self._error}>"


class _HostProxy:
    """内核命名空间里的 host 对象：host.<method>(*args) → 反向调用宿主播进程，阻塞等应答。"""

    def __init__(self, kernel):
        object.__setattr__(self, "_kernel", kernel)

    def __getattr__(self, method):
        kernel = object.__getattribute__(self, "_kernel")

        def call(*args):
            return kernel.server.host_call(method, list(args), kernel.name)

        return call


class _Kernel:
    """一个具名内核 = 一个 globals 命名空间。执行统一在 daemon 主线程（见模块 docstring）。"""

    def __init__(self, name, server):
        self.name = name
        self.server = server
        self.namespace = {"__name__": "__main__", "_": None}
        self.namespace["host"] = _HostProxy(self)
        self.namespace["reload_skills"] = self.load_skills
        self.load_skills()

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

    def load_skills(self):
        """按 prime 契约装载技能目录；返回 {技能名: 错误}（空字典=全绿）。
        装载产物：命名空间里的技能模块、list_skills()、_skill_catalog、_skill_errors。"""
        errors = {}
        catalog = []
        skills_dir = self.server.skills_dir
        if os.path.isdir(skills_dir):
            for entry in sorted(os.listdir(skills_dir)):
                sdir = os.path.join(skills_dir, entry)
                skill_md = os.path.join(sdir, "SKILL.md")
                pyproject = os.path.join(sdir, "pyproject.toml")
                if not os.path.isdir(sdir) or not (os.path.isfile(skill_md) and os.path.isfile(pyproject)):
                    continue  # 非技能目录（或纯 markdown 技能无 python 半），跳过
                meta_err = _validate_skill_md(skill_md, entry)
                if meta_err:
                    errors[entry] = meta_err
                    continue
                import_name = entry.replace("-", "_")
                if not import_name.isidentifier():
                    errors[entry] = f'import 名 "{import_name}" 不是合法 Python 标识符'
                    continue
                if not os.path.isfile(os.path.join(sdir, "src", import_name, "__init__.py")):
                    errors[entry] = f"src/{import_name}/__init__.py 不存在（src 布局是硬契约）"
                    continue
                dep_err = self.server.ensure_skill_deps(pyproject)
                if dep_err:
                    errors[entry] = dep_err
                    continue
                src_dir = os.path.join(sdir, "src")
                if src_dir not in sys.path:
                    sys.path.insert(0, src_dir)
                try:
                    if import_name in sys.modules:
                        module = importlib.reload(sys.modules[import_name])
                    else:
                        module = importlib.import_module(import_name)
                    self.namespace[import_name] = _wrap_callable_module(module)
                    meta = _parse_skill_md(skill_md)
                    catalog.append({"name": entry, "description": meta.get("description", ""), "import_name": import_name})
                except BaseException:
                    err = traceback.format_exc().strip().splitlines()[-1]
                    self.namespace[import_name] = _UnavailableSkill(import_name, err)
                    errors[entry] = err
        self.namespace["_skill_errors"] = errors
        self.namespace["_skill_catalog"] = catalog
        self.namespace["list_skills"] = lambda: list(catalog)
        return dict(errors)

    def reset(self):
        self.namespace.clear()
        self.namespace.update({"__name__": "__main__", "_": None, "host": _HostProxy(self)})
        self.namespace["reload_skills"] = self.load_skills
        self.load_skills()

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
    def __init__(self, sock_path, log_path, skills_dir):
        self.sock_path = sock_path
        self.skills_dir = skills_dir
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


    # PyPI 名 → import 名 的常见映射（对齐 prime 文档里的常用包）；查不到用原名
    _DEP_IMPORT_NAMES = {
        "beautifulsoup4": "bs4", "pyyaml": "yaml", "python-dotenv": "dotenv",
        "pillow": "PIL", "scikit-learn": "sklearn", "opencv-python": "cv2",
    }

    def ensure_skill_deps(self, pyproject_path):
        """按 pyproject dependencies 保证依赖可用：先试 import，缺失则
        pip --target 装进 <socket目录>/skill-deps（隔离目录，不污染 daemon 解释器）。
        全部就绪返回 None，否则返回错误描述。prime-agent-runtime 在 dsh 无对应物，
        声明它的技能直接报可用性错误（host 桥是这里的等价物）。"""
        try:
            import tomllib
            with open(pyproject_path, "rb") as f:
                data = tomllib.load(f)
        except Exception as exc:
            return f"pyproject.toml 解析失败: {exc}"
        deps = data.get("project", {}).get("dependencies", []) or []
        if not deps:
            return None
        deps_dir = os.path.join(os.path.dirname(self.sock_path), "skill-deps")
        for dep in deps:
            name = re.split(r"[<>=!~\[; ]", dep, 1)[0].strip()
            if not name:
                continue
            if name == "prime-agent-runtime":
                return "声明了 prime-agent-runtime：dsh 运行时无此物（host 桥是等价物），请移除该依赖"
            import_name = self._DEP_IMPORT_NAMES.get(name.lower(), name.replace("-", "_"))
            try:
                importlib.import_module(import_name)
                continue  # 已可用
            except ImportError:
                pass
            os.makedirs(deps_dir, exist_ok=True)
            if deps_dir not in sys.path:
                sys.path.insert(0, deps_dir)
            proc = subprocess.run(
                [sys.executable, "-m", "pip", "install", "--quiet", "--target", deps_dir, dep],
                capture_output=True, text=True, timeout=300,
            )
            if proc.returncode != 0:
                return f"依赖 {dep} 安装失败: {(proc.stderr or proc.stdout).strip()[-200:]}"
            try:
                importlib.import_module(import_name)
            except ImportError as exc:
                return f"依赖 {dep} 装完仍不可 import: {exc}"
        return None

    def kernel(self, name):
        if name not in self.kernels:
            self.kernels[name] = _Kernel(name, self)
        return self.kernels[name]

    def executor_loop(self):
        """主线程循环：串行消费所有内核的 cell。SIGINT 在此线程触发 KeyboardInterrupt。"""
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

    def host_call(self, method, args, kernel):
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
        self._reply(conn, {"kind": "host_call", "id": call_id, "kernel": kernel, "method": method, "args": args})
        # 双保险唤醒：宿主应答，或连接断开/超时（否则执行器会被一次丢失的应答永久卡死）
        if not ev.wait(600):
            del self.pending_host[call_id]
            raise RuntimeError(f"宿主方法 {method} 应答超时（600s）")
        del self.pending_host[call_id]
        if not box.get("ok"):
            raise RuntimeError(f"宿主方法 {method} 失败: {box.get('error')}")
        return box.get("value")

    def _fail_all_host_calls(self, reason):
        for ev, box in self.pending_host.values():
            if not ev.is_set():
                box.update({"ok": False, "error": reason})
                ev.set()

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
            self._fail_all_host_calls("宿主连接被新连接接管")
            _log(self.logf, "client connected")
            threading.Thread(target=self._reader, args=(conn,), daemon=True).start()


def main():
    # SIGINT 不屏蔽：它是 interrupt 操作的载体，在主线程触发 KeyboardInterrupt 杀 cell。
    # daemon 本体终止走 SIGTERM（宿主不依赖终端 Ctrl-C——daemon 脱离终端运行）。
    sock_path, log_path = sys.argv[1], sys.argv[2]
    # 技能目录（可选 argv[3]，默认 socket 旁的 ./skills）：每个新内核创建时
    # 把目录下所有 .py 依次 exec 进命名空间——agent 给自己造的工具由此常住。
    skills_dir = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.path.dirname(sock_path), "skills")
    server = _Server(sock_path, log_path, skills_dir)
    threading.Thread(target=server.serve, daemon=True).start()
    server.executor_loop()


if __name__ == "__main__":
    main()
