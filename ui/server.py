"""本地控制台：用浏览器 UI 控制 X 自动化（只依赖标准库）。

启动：
    python ui/server.py            # 打开 http://127.0.0.1:9300
    python ui/server.py --port 9301

设计要点：
  · 这个服务只做两件事：读状态、拉起/停止 tools/x_*.py 子进程
  · 子进程输出写进 xauto/data/ui-runs/<job>.log，UI 轮询 tail 显示
  · 同一时间只允许跑一个"驱动浏览器"的任务（互斥锁），避免两个进程抢鼠标
  · 不碰浏览器本身；浏览器仍然由 x_launch.py 启动、由各工具真实键鼠操作
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# --instance 要先于 import config（config 在导入时就把档位解析成端口/profile/数据目录）
for _i, _arg in enumerate(sys.argv):
    if _arg == "--instance" and _i + 1 < len(sys.argv):
        os.environ["XAUTO_INSTANCE"] = sys.argv[_i + 1]
    elif _arg.startswith("--instance="):
        os.environ["XAUTO_INSTANCE"] = _arg.split("=", 1)[1]

from xauto import config as _cfg  # noqa: E402  —— 控制台跟着档位走：test=9234，prod=9235

RUN_DIR = _cfg.DATA_DIR / "ui-runs"
SCHEDULE_FILE = _cfg.DATA_DIR / "schedule.json"
PY = sys.executable or "python"

LOCK = threading.Lock()
JOBS: dict[str, dict] = {}          # job_id -> info
_acting_job: str | None = None      # 当前占用浏览器的那一个


# ---------------- 定时计划（每天某点自动跑一轮）----------------

def load_schedule() -> dict:
    d = {"enabled": False, "at": "14:00", "action": "repeat",
         "params": {"cycles": 1, "follows": 3, "replies": 3,
                    "read_min": 30, "read_max": 50, "yes": True},
         "last_run": ""}
    try:
        if SCHEDULE_FILE.exists():
            d.update(json.loads(SCHEDULE_FILE.read_text(encoding="utf-8")))
    except Exception:
        pass
    return d


def save_schedule(updates: dict) -> dict:
    d = load_schedule()
    for k in ("enabled", "at", "action", "params", "last_run"):
        if k in updates:
            d[k] = updates[k]
    SCHEDULE_FILE.parent.mkdir(parents=True, exist_ok=True)
    SCHEDULE_FILE.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
    return d


def next_fire_text(sch: dict) -> str:
    """算下次触发时间（只支持每天定点）。"""
    if not sch.get("enabled") or not sch.get("at"):
        return "未启用"
    try:
        hh, mm = [int(x) for x in str(sch["at"]).split(":")[:2]]
    except Exception:
        return "时间格式错误"
    now = time.localtime()
    target = time.mktime((now.tm_year, now.tm_mon, now.tm_mday, hh, mm, 0, 0, 0, -1))
    if target <= time.time():
        target += 86400
    return time.strftime("%m-%d %H:%M", time.localtime(target))


def _scheduler_loop() -> None:
    """每 20 秒看一眼：到点且今天还没跑过，就拉起任务。"""
    while True:
        try:
            sch = load_schedule()
            if sch.get("enabled"):
                today = time.strftime("%Y-%m-%d")
                now_hm = time.strftime("%H:%M")
                if now_hm == str(sch.get("at", ""))[:5] and sch.get("last_run") != today:
                    with LOCK:
                        busy = _acting_job and JOBS.get(_acting_job, {}).get("status") == "running"
                    if busy:
                        print(f"[sched] 到点了但有任务在跑，等下一次检查")
                    else:
                        print(f"[sched] 触发定时任务：{sch.get('action')}")
                        r = start_job(sch.get("action", "loop"), sch.get("params") or {})
                        if r.get("ok"):
                            sch["last_run"] = today
                            save_schedule(sch)
                        else:
                            print(f"[sched] 启动失败：{r.get('error')}")
                        # 同一分钟只试一次，避免重复拉起
                        sch["last_run"] = today
                        save_schedule(sch)
        except Exception as e:
            print(f"[sched] 异常：{e}")
        time.sleep(20)


# ---------------- 动作定义（UI 上的按钮就是这些）----------------

ACTIONS = {
    # ================= 创作与回复 =================
    "session": {
        "name": "SOP 浏览会话", "group": "创作与回复",
        "desc": "通知 → 关注时间线 → 推荐；三层阅读；赞/评/藏各自独立；时间盒到点停。默认 dry-run。",
        "cmd": ["tools/x_session.py"],
        "params": [{"key": "minutes", "label": "时间盒(分钟，0=用行为设置)", "type": "number", "default": 0},
                   {"key": "yes", "label": "真的执行写操作", "type": "bool", "default": False}],
    },
    "notif": {
        "name": "回复通知（别人回我）", "group": "创作与回复",
        "desc": "通知里「回复了你/提到了你」→ 读原帖 → 回应；纯表情跳过。",
        "cmd": ["tools/x_notif.py"],
        "params": [{"key": "n", "label": "回复几条", "type": "number", "default": 3},
                   {"key": "kind", "label": "类型 reply/mention/both", "type": "text", "default": "both"},
                   {"key": "yes", "label": "真的发出去", "type": "bool", "default": False}],
    },
    "post": {
        "name": "发帖（可 AI 生成）", "group": "创作与回复",
        "desc": "给正文直接发；或只给主题让模型按语气/风格写。默认 dry-run。走首页内联框。",
        "cmd": ["tools/x_post.py"],
        "params": [{"key": "text", "label": "正文", "type": "text", "default": ""},
                   {"key": "topic", "label": "主题（留空则用正文）", "type": "text", "default": ""},
                   {"key": "home", "label": "首页内联框", "type": "flag", "value": True, "default": True},
                   {"key": "yes", "label": "真的发出去", "type": "bool", "default": False}],
    },
    "thread": {
        "name": "从回复页互动原帖", "group": "创作与回复",
        "desc": "在回复列表里对主帖点赞+评论（当前页或先从首页点开一条）。",
        "cmd": ["tools/x_thread.py"],
        "params": [{"key": "from_home", "label": "先从首页点开一条", "type": "bool", "default": True},
                   {"key": "yes", "label": "真的执行", "type": "bool", "default": False}],
    },

    # ================= 用户与关注 =================
    "follow": {
        "name": "关注 / 取关", "group": "用户与关注",
        "desc": "按内容质量挑人关注（先看简介+近期多篇）；取关单次最多 3 个。",
        "cmd": ["tools/x_follow.py"],
        "params": [{"key": "follow", "label": "关注几个", "type": "number", "default": 0},
                   {"key": "unfollow", "label": "取关几个(≤3)", "type": "number", "default": 0},
                   {"key": "yes", "label": "真的执行", "type": "bool", "default": False}],
    },
    "dm": {
        "name": "私信（我的消息）", "group": "用户与关注",
        "desc": "列出私信会话并回复（默认只列不写）。",
        "cmd": ["tools/x_dm.py"],
        "params": [{"key": "n", "label": "处理几个会话", "type": "number", "default": 1},
                   {"key": "list", "label": "只列会话", "type": "bool", "default": True}],
    },

    # ================= 查询与管理 =================
    "bookmarks": {
        "name": "收藏消化", "group": "查询与管理",
        "desc": "看未消化收藏（分类显示），可标记已消化/不再需要。",
        "cmd": ["tools/x_bookmarks.py"],
        "params": [{"key": "list", "label": "列出未消化", "type": "flag", "value": True, "default": True},
                   {"key": "digest", "label": "标记前 N 条已消化", "type": "number", "default": 0}],
    },
    "report": {
        "name": "周复盘（SOP 13）", "group": "查询与管理",
        "desc": "评论/点赞/关注/原创比、收藏消化率、新关注名单、需人工回顾项。",
        "cmd": ["tools/x_report.py"],
        "params": [{"key": "days", "label": "统计天数", "type": "number", "default": 7}],
    },
    "health": {
        "name": "账号运营与健康", "group": "查询与管理",
        "desc": "主页数据、引导清单、受限提示、今日用量与剩余额度、行为设置一览。",
        "cmd": ["tools/x_health.py"],
        "params": [],
    },
    "query": {
        "name": "数据查询", "group": "查询与管理",
        "desc": "查自己 / 查某人 / 查当前这条帖子的数据（点界面，不输网址）。",
        "cmd": ["tools/x_query.py"],
        "params": [{"key": "user", "label": "用户（留空=查自己）", "type": "text", "default": ""},
                   {"key": "current", "label": "查当前这条帖子", "type": "bool", "default": False}],
    },
    "export_people": {
        "name": "导出列表成员", "group": "查询与管理",
        "desc": "导出我的关注列表或当前页出现的用户 → CSV。",
        "cmd": ["tools/x_export.py"],
        "params": [{"key": "following", "label": "导出我的关注列表", "type": "bool", "default": True},
                   {"key": "page", "label": "导出当前页用户", "type": "bool", "default": False},
                   {"key": "max", "label": "最多导出", "type": "number", "default": 200}],
    },
    "collect": {
        "name": "从评论收集作者", "group": "查询与管理",
        "desc": "把一条帖子回复区里的作者收集成 CSV。",
        "cmd": ["tools/x_collect.py"],
        "params": [{"key": "from_timeline", "label": "先从首页点开一条(1/0)", "type": "number", "default": 1},
                   {"key": "max", "label": "最多收集", "type": "number", "default": 200}],
    },
    "delete": {
        "name": "删除帖子", "group": "查询与管理",
        "desc": "删主页上最近 N 条（最多 10）。默认只预览。",
        "cmd": ["tools/x_delete.py"],
        "params": [{"key": "n", "label": "删几条", "type": "number", "default": 1},
                   {"key": "text", "label": "只删含关键词的", "type": "text", "default": ""},
                   {"key": "yes", "label": "真的删除", "type": "bool", "default": False}],
    },
    "repeat": {
        "name": "连续会话（多轮）", "group": "查询与管理",
        "desc": "每轮一次 SOP 会话，轮间隔 40±10 分钟。SOP 建议默认不用；需要长时间跑时开。",
        "cmd": ["tools/x_repeat.py"],
        "params": [{"key": "cycles", "label": "跑几轮（0=一直）", "type": "number", "default": 2},
                   {"key": "base_min", "label": "轮间隔(分钟)", "type": "number", "default": 40},
                   {"key": "yes", "label": "真的执行", "type": "bool", "default": True}],
    },
    "instance": {
        "name": "档位实例（test/prod）", "group": "查询与管理",
        "desc": "起 test(9234)/prod(9235) 实例、看两档状态、把当前窗口登录的号绑定到本档位。",
        "cmd": ["tools/x_instance.py"],
        "params": [{"key": "target", "label": "档位 test/prod（留空=总览）", "type": "pos", "default": ""},
                   {"key": "bind", "label": "把当前登录号绑定到该档位", "type": "bool", "default": False},
                   {"key": "status", "label": "只看两档状态", "type": "flag", "value": True, "default": False}],
    },
    "probe": {
        "name": "环境自检", "group": "查询与管理",
        "desc": "端口/登录/当前页面/时间线条数等基本状态。",
        "cmd": ["tools/x_probe.py"],
        "params": [],
    },
    "selftest": {
        "name": "发帖自检", "group": "查询与管理",
        "desc": "把发帖链路跑到提交前一步，绝不发布。",
        "cmd": ["tools/x_post.py"],
        "params": [{"key": "selftest", "label": "自检模式", "type": "flag", "value": True, "default": True}],
    },
}

# ---------------- 浏览器/账号状态 ----------------

def _opener():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def cdp_status(port: int | None = None) -> dict:
    port = port or _cfg.CDP_PORT
    try:
        raw = _opener().open(f"http://127.0.0.1:{port}/json/version", timeout=2.5).read()
        ver = json.loads(raw)
        targets = []
        try:
            tl = json.loads(_opener().open(f"http://127.0.0.1:{port}/json/list",
                                           timeout=2.5).read())
            targets = [{"title": t.get("title", "")[:60], "url": t.get("url", "")[:90]}
                       for t in tl if t.get("type") == "page"]
        except Exception:
            pass
        return {"alive": True, "browser": ver.get("Browser", ""), "targets": targets}
    except Exception as e:
        return {"alive": False, "error": str(e)}


def store_summary() -> dict:
    try:
        from xauto import store
        return store.summary()
    except Exception as e:
        return {"error": str(e)}


def page_status() -> dict:
    """连一下页面拿账号/URL（失败就返回空，不影响 UI）。"""
    try:
        from xauto.session import XSession
        s = XSession()
        s.connect()
        try:
            st = s.status()
            return {"url": st.get("href", ""), "logged_in": st.get("logged_in", False),
                    "title": st.get("title", "")}
        finally:
            s.disconnect()
    except Exception as e:
        return {"error": str(e)}


# ---------------- 任务管理 ----------------

def _new_job_id(action: str) -> str:
    return f"{action}-{time.strftime('%H%M%S')}"


def build_cmd(action: str, params: dict) -> list[str]:
    spec = ACTIONS[action]
    cmd = [PY] + spec["cmd"]
    for p in spec["params"]:
        key = p["key"]
        val = params.get(key, p.get("default"))
        typ = p["type"]
        if typ == "bool":
            if val:
                cmd.append(f"--{key}")
        elif typ == "flag":
            if val:
                cmd.append(f"--{key}")
        elif typ == "pos":                      # 位置参数（例如 x_instance.py test|prod）
            if val not in (None, "", False):
                cmd.append(str(val))
        elif typ == "number":
            cmd += [f"--{key}", str(int(float(val)))] if val not in (None, "") else []
        else:
            if val:
                cmd += [f"--{key}", str(val)]
    # 统一加 --json 便于日志里保留结构化结果（工具都支持）
    if "--json" not in cmd:
        cmd.append("--json")
    return cmd


def start_job(action: str, params: dict) -> dict:
    global _acting_job
    if action not in ACTIONS:
        return {"ok": False, "error": f"未知动作：{action}"}
    with LOCK:
        if _acting_job and JOBS.get(_acting_job, {}).get("status") == "running":
            return {"ok": False, "error": f"已有任务在跑（{_acting_job}），浏览器不能同时被两个进程操作"}
        jid = _new_job_id(action)
        RUN_DIR.mkdir(parents=True, exist_ok=True)
        log_path = RUN_DIR / f"{jid}.log"
        cmd = build_cmd(action, params)
        env = dict(os.environ, PYTHONIOENCODING="utf-8")
        # 输入通道：UI 选什么就传给子进程（os=真实鼠标 / cdp=后台不占鼠标）
        try:
            from xauto import settings as _settings
            env["XAUTO_INPUT"] = _settings.input_mode()
        except Exception:
            pass
        f = open(log_path, "w", encoding="utf-8", buffering=1)
        proc = subprocess.Popen(cmd, cwd=str(ROOT), env=env,
                                stdout=f, stderr=subprocess.STDOUT,
                                creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))
        JOBS[jid] = {"id": jid, "action": action, "name": ACTIONS[action]["name"],
                     "status": "running", "started": time.strftime("%m-%d %H:%M:%S"),
                     "log": str(log_path), "cmd": cmd, "proc": proc, "f": f,
                     "params": params}
        _acting_job = jid
        threading.Thread(target=_watch, args=(jid,), daemon=True).start()
        return {"ok": True, "job_id": jid}


def _watch(jid: str) -> None:
    global _acting_job
    job = JOBS.get(jid)
    if not job:
        return
    proc: subprocess.Popen = job["proc"]
    proc.wait()
    job["status"] = "done" if proc.returncode == 0 else f"exit{proc.returncode}"
    job["ended"] = time.strftime("%m-%d %H:%M:%S")
    try:
        job["f"].close()
    except Exception:
        pass
    with LOCK:
        if _acting_job == jid:
            _acting_job = None


def stop_job(jid: str) -> dict:
    job = JOBS.get(jid)
    if not job or job["status"] != "running":
        return {"ok": False, "error": "任务不在运行"}
    proc: subprocess.Popen = job["proc"]
    try:
        proc.terminate()
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
    return {"ok": True}


def job_list() -> list[dict]:
    out = []
    for j in sorted(JOBS.values(), key=lambda x: x["id"], reverse=True)[:12]:
        out.append({k: j[k] for k in ("id", "action", "name", "status", "started") if k in j}
                   | ({"ended": j["ended"]} if "ended" in j else {}))
    return out


def tail_log(jid: str, lines: int = 200) -> dict:
    job = JOBS.get(jid)
    path = Path(job["log"]) if job else (RUN_DIR / f"{jid}.log")
    if not path.exists():
        return {"ok": False, "error": "没有该任务的日志", "text": ""}
    try:
        txt = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except Exception as e:
        return {"ok": False, "error": str(e), "text": ""}
    return {"ok": True, "text": "\n".join(txt[-lines:]), "lines": len(txt)}


def executed_activity(limit: int = 40) -> dict:
    """最近真的干了什么：评论、阅读、关注（从 store + read-log 里取）。"""
    out = {"replies": [], "reads": [], "follows": []}
    try:
        from xauto import store
        d = json.loads(Path(store.config.STATE_FILE).read_text(encoding="utf-8"))
        rt = d.get("replied_tweets", {})
        out["replies"] = [{"at": v.get("at", ""), "text": (v.get("text") or "")[:120],
                           "href": v.get("href", "")}
                          for v in list(rt.values())[-limit:]][::-1]
        fl = d.get("followed", {})
        out["follows"] = [{"at": v.get("at", ""), "handle": k}
                          for k, v in list(fl.items())[-limit:]][::-1]
    except Exception:
        pass
    try:
        p = _cfg.DATA_DIR / "read-log.jsonl"
        if p.exists():
            lines = p.read_text(encoding="utf-8", errors="replace").splitlines()[-limit:]
            for line in lines:
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                if rec.get("id"):
                    out["reads"].append({"at": rec.get("at", ""), "handle": rec.get("handle", ""),
                                         "chars": rec.get("chars", 0),
                                         "text": (rec.get("text") or "")[:120]})
            out["reads"] = out["reads"][::-1]
    except Exception:
        pass
    return out


def _behavior() -> dict:
    try:
        from xauto import behavior
        return {"values": behavior.load(), "options": behavior.options()}
    except Exception:
        return {"values": {}, "options": {}}


def status() -> dict:
    sch = load_schedule()
    try:
        from xauto import limits as lim
        caps = lim.load()
    except Exception:
        caps = {}
    try:
        from xauto import settings as st
        cfg = st.load()
    except Exception:
        cfg = {"input_mode": "os"}
    return {
        "now": time.strftime("%Y-%m-%d %H:%M:%S"),
        "browser": cdp_status(),
        "page": page_status(),
        "counters": store_summary(),
        "jobs": job_list(),
        "acting": _acting_job,
        "schedule": {**sch, "next": next_fire_text(sch)},
        "limits": caps,
        "settings": cfg,
        "behavior": _behavior(),
        "actions": [{"id": k, **{kk: vv for kk, vv in v.items() if kk != "cmd"}}
                    for k, v in ACTIONS.items()],
    }


# ---------------- HTTP ----------------

class Handler(BaseHTTPRequestHandler):
    server_version = "xauto-ui/1.0"

    def log_message(self, fmt, *args):        # 安静点
        pass

    def _send(self, code: int, body: bytes, ctype="application/json; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code: int = 200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        if u.path in ("/", "/index.html"):
            html = (Path(__file__).resolve().parent / "index.html").read_bytes()
            self._send(200, html, "text/html; charset=utf-8")
            return
        if u.path == "/api/status":
            self._json(status())
            return
        if u.path == "/api/activity":
            self._json(executed_activity())
            return
        if u.path == "/api/log":
            self._json(tail_log(q.get("job_id", [""])[0],
                                int(q.get("lines", ["200"])[0])))
            return
        if u.path == "/api/schedule":
            sch = load_schedule()
            self._json({**sch, "next": next_fire_text(sch)})
            return
        if u.path == "/api/behavior":
            self._json({"ok": True, **_behavior()})
            return
        if u.path == "/api/settings":
            try:
                from xauto import settings as st
                self._json({"ok": True, "settings": st.load()})
            except Exception as e:
                self._json({"ok": False, "error": str(e)})
            return
        self._json({"ok": False, "error": "not found"}, 404)

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            body = {}
        if u.path == "/api/run":
            self._json(start_job(body.get("action", ""), body.get("params") or {}))
            return
        if u.path == "/api/stop":
            self._json(stop_job(body.get("job_id", "")))
            return
        if u.path == "/api/schedule":
            self._json({"ok": True, "schedule": save_schedule(body)})
            return
        if u.path == "/api/limits":
            try:
                from xauto import limits as lim
                self._json({"ok": True, "limits": lim.save(body.get("limits") or {})})
            except Exception as e:
                self._json({"ok": False, "error": str(e)})
            return
        if u.path == "/api/behavior":
            try:
                from xauto import behavior as bh
                self._json({"ok": True, "values": bh.save(body)})
            except Exception as e:
                self._json({"ok": False, "error": str(e)})
            return
        if u.path == "/api/settings":
            try:
                from xauto import settings as st
                self._json({"ok": True, "settings": st.save(body)})
            except Exception as e:
                self._json({"ok": False, "error": str(e)})
            return
        self._json({"ok": False, "error": "not found"}, 404)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--instance", choices=("test", "prod"),
                    help="档位：test=浏览器9234（测试号），prod=浏览器9235（正式号）。"
                         "控制台端口随之为 9300/9301")
    ap.add_argument("--port", type=int, default=9300 if _cfg.INSTANCE == "test" else 9301)
    ap.add_argument("--host", default="127.0.0.1")
    a = ap.parse_args()
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    threading.Thread(target=_scheduler_loop, daemon=True).start()
    print(f"[ok] X 自动化控制台：http://{a.host}:{a.port}")
    sch = load_schedule()
    print(f"     定时计划：{'启用' if sch.get('enabled') else '未启用'} "
          f"每天 {sch.get('at')} → {sch.get('action')}（下次 {next_fire_text(sch)}）")
    print(f"     {_cfg.instance_banner()}")
    print("     UI 只负责拉起工具进程；浏览器窗口由 x_launch.py / x_instance.py 管理。")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n[byebye]")
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
