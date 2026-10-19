#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""微信桥 sidecar：把本机已登录的微信 4.x 客户端包成一层 JSON-RPC。

设计约束（很重要，别改坏）：

* **stdout 只走协议**。任何日志、警告、第三方库的 print 都必须留在 stderr，
  否则 Node 侧解析会错位。启动时第一件事就是把 sys.stdout 换成只给协议用的
  UTF-8 二进制写口。
* **OCR 默认关闭**。``wechatauto`` 的 OCR 依赖 ``winsdk``，而 winsdk 在
  Python 3.13 上没有可装的轮子；把 ``WxParam.ENABLE_OCR`` 置 False 后
  ``ScreenOCR.recognize()`` 会在 import 之前就返回空列表，发送链路自动走
  UIA（实测微信 4.1.15.13 可用）。不要在未确认可用的前提下打开它。
* **不做未经请求的写入**。``send`` 必须带明确的 ``chat``；调用方要给出
  真名或 username，桥不替人猜「大概是谁」——重名直接报错并要求 username。
* **只读优先**。除 ``send`` 外所有方法都不驱动界面，只解密本地数据库。

协议：一行一个 JSON。

    {"id": 1, "method": "messages", "params": {...}}
    {"id": 1, "ok": true, "result": {...}}
    {"id": 1, "ok": false, "error": "..."}
"""

import io
import json
import os
import re
import sys
import time
import traceback

# ---------------------------------------------------------------- stdio 协议
_PROTOCOL_OUT = sys.stdout.buffer
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
sys.stderr = io.TextIOWrapper(
    sys.stderr.buffer, encoding="utf-8", errors="replace", line_buffering=True
)

_HERE = os.path.dirname(os.path.abspath(__file__))
_STATE_DIR = os.path.join(_HERE, ".state")
os.makedirs(_STATE_DIR, exist_ok=True)

_CONFIG = {
    "dbDir": None,          # None = 让库自己找；本机在 E:\itchat\xwechat_files
    "enableOcr": False,
    "confirmSec": 12,       # 发送后回读数据库的等待上限
    "maxMessages": 100,
}

_STATE_FILE = os.path.join(_STATE_DIR, "state.json")

# 微信内置的系统会话在 contact 表里没有可读昵称，直接给中文名。
SYSTEM_NAMES = {
    "filehelper": "文件传输助手",
    "weixin": "微信团队",
    "notifymessage": "服务通知",
    "medianote": "语音记事本",
    "fmessage": "朋友推荐消息",
    "qqmail": "QQ邮箱",
    "qqsafe": "QQ安全中心",
    "brandsessionholder": "服务号",
    "newsapp": "腾讯新闻",
    "floatbottle": "漂流瓶",
    "weibo": "微博",
    "qqfriend": "QQ好友",
}


def log(message):
    """stderr 日志；不参与协议。"""
    sys.stderr.write("[bridge] %s\n" % message)
    sys.stderr.flush()


def _load_state():
    try:
        with open(_STATE_FILE, "r", encoding="utf-8") as handle:
            data = json.load(handle)
            if isinstance(data, dict):
                return data
    except FileNotFoundError:
        pass
    except Exception as error:  # 状态文件坏了不该让桥起不来
        log("状态文件读取失败，按空状态处理：%s" % error)
    return {}


def _save_state(state):
    tmp = _STATE_FILE + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(state, handle, ensure_ascii=False, indent=1)
        os.replace(tmp, _STATE_FILE)
    except Exception as error:
        log("状态文件写入失败：%s" % error)


# ---------------------------------------------------------------- wechatauto
def _import_library():
    """延迟导入：只有真正用到时才付导入成本。

    ``WxParam.ENABLE_OCR`` 必须在任何 wechatauto 模块导入 guia/uia_driver
    之前设置，所以这里按顺序做，不放在模块顶部。
    """
    from wechatauto.param import WxParam

    WxParam.ENABLE_OCR = bool(_CONFIG.get("enableOcr"))
    from wechatauto import db as db_module

    return db_module


class Bridge:
    """所有状态集中在这里，单线程顺序处理请求。"""

    def __init__(self):
        self._db_module = None
        self._db = None
        self._gui = None
        self._names = None
        self._state = _load_state()

    # ------------------------------------------------------------ 惰性构造
    def db_module(self):
        if self._db_module is None:
            self._db_module = _import_library()
        return self._db_module

    def db(self, fresh=False):
        module = self.db_module()
        if fresh or self._db is None:
            kwargs = {}
            if _CONFIG.get("dbDir"):
                kwargs["db_dir"] = _CONFIG["dbDir"]
            self._db = module.WeChatDB(**kwargs)
        return self._db

    def gui(self):
        if self._gui is None:
            # 这里才第一次碰界面：热激活 UIA、校准布局，约 10-20s。
            from wechatauto.guia import WeChatGUI

            log("初始化 WeChatGUI（首次会做 UIA 热激活与布局校准）")
            self._gui = WeChatGUI()
        return self._gui

    # ------------------------------------------------------------ 名字解析
    def name_map(self):
        """wxid / 群号 → 显示名。一次建好，之后纯内存查。"""
        if self._names is not None:
            return self._names
        mapping = {}
        db = self.db()
        try:
            for key, value in (db.nickname_map() or {}).items():
                if value:
                    mapping[key] = value
        except Exception as error:
            log("nickname_map 失败：%s" % error)
        try:
            for group in db.get_groups() or []:
                username = group.get("username")
                if username and group.get("name"):
                    mapping[username] = group["name"]
        except Exception as error:
            log("get_groups 失败：%s" % error)
        self._names = mapping
        return mapping

    def display_name(self, username):
        if not username:
            return ""
        mapping = self.name_map()
        if username in mapping:
            return mapping[username]
        if username in SYSTEM_NAMES:
            return SYSTEM_NAMES[username]
        try:
            resolved = self.db().get_nickname(username)
            if resolved and resolved != username:
                mapping[username] = resolved
                return resolved
        except Exception:
            pass
        return username

    def resolve_target(self, chat):
        """把用户给的名字/号解析成 (username, displayName)。

        重名直接报错——宁可不发，也不替人猜。
        """
        chat = (chat or "").strip()
        if not chat:
            raise ValueError("必须给出 chat（会话名、备注名或 username）")
        db = self.db()
        # 已经像 username 的，原样认。
        if chat.endswith("@chatroom") or chat.startswith("wxid_") or chat in (
            "filehelper",
            "weixin",
            "notifymessage",
        ):
            return chat, self.display_name(chat)
        mapping = self.name_map()
        # 反向精确匹配显示名（备注优先，其次昵称）
        exact = [key for key, value in mapping.items() if value == chat]
        if len(exact) == 1:
            return exact[0], chat
        if len(exact) > 1:
            raise ValueError(
                "「%s」对应多个会话，请改用 username 指定：%s"
                % (chat, ", ".join(sorted(exact)[:8]))
            )
        try:
            username = db.username_by_nickname(chat)
            if username:
                return username, self.display_name(username)
        except Exception as error:
            log("username_by_nickname 失败：%s" % error)
        # 最后交给微信自己的搜索框去认（界面侧仍可能命中）
        return None, chat

    # ------------------------------------------------------------ 消息格式化
    @staticmethod
    def _clean_content(content, sender_username, is_group):
        """群消息正文带 ``wxid_xxx:\\n`` 前缀，剥掉。"""
        text = content if isinstance(content, str) else str(content or "")
        if is_group and sender_username and text.startswith(sender_username + ":"):
            text = text[len(sender_username) + 1:]
            if text.startswith("\n"):
                text = text[1:]
        return text

    @staticmethod
    def _summarize(type_name, text):
        """非文本消息的正文是整段 XML（含 aeskey / md5 / cdn url）。

        这些是**密钥和下载凭证**，既没用也不该进模型上下文，一律折叠成一行
        可读摘要。文本消息原样返回。
        """
        if not text:
            return ""
        if not text.lstrip().startswith("<"):
            return text[:4000]
        title_match = re.search(r"<title>(.*?)</title>", text, re.S)
        title = (title_match.group(1) if title_match else "").strip()[:80]
        if "<fileext>" in text or "<appattach" in text:
            ext_match = re.search(r"<fileext>(.*?)</fileext>", text)
            ext = ext_match.group(1) if ext_match else ""
            name = title or ("." + ext if ext else "文件")
            return ("[文件] %s" % name)[:120]
        if "<img" in text:
            return "[图片]"
        if "<voipmsg" in text:
            return "[音视频通话]"
        if "<emoji" in text:
            return "[表情]"
        if "<videomsg" in text:
            return "[视频]"
        if "<sysmsg" in text:
            return "[系统消息]"
        if "<appmsg" in text:
            return ("[卡片] %s" % title)[:120] if title else "[卡片]"
        return "[非文本]"

    def message_view(self, row, chat_username=None, is_group=None):
        db = self.db()
        is_group = bool(is_group) if is_group is not None else bool(
            (chat_username or "").endswith("@chatroom")
        )
        sender_username = row.get("sender_username") or ""
        self_username = getattr(db, "wxid", "")
        is_self = bool(sender_username) and sender_username == self_username
        create_time = row.get("create_time") or 0
        type_name = row.get("type") or ""
        raw = self._clean_content(row.get("content"), sender_username, is_group)
        text = self._summarize(type_name, raw) or ("[%s]" % type_name if type_name else "")
        return {
            "id": row.get("local_id"),
            "shard": row.get("shard"),
            "time": create_time,
            "timeText": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(create_time))
            if create_time
            else "",
            "sender": self.display_name(sender_username) if sender_username else "",
            "senderUsername": sender_username,
            "isSelf": is_self,
            "type": type_name,
            "text": text[:4000],
        }

    # ------------------------------------------------------------ 方法
    def m_init(self, params):
        for key in ("dbDir", "enableOcr", "confirmSec", "maxMessages"):
            if key in params:
                _CONFIG[key] = params[key]
        return {"config": _CONFIG, "python": sys.version.split()[0]}

    def m_doctor(self, params):
        import psutil

        processes = []
        for process in psutil.process_iter(["name", "exe"]):
            try:
                name = (process.info.get("name") or "").lower()
                if name not in ("weixin.exe", "wechat.exe"):
                    continue
                exe = process.info.get("exe") or ""
                version = ""
                if exe and os.path.exists(exe):
                    import win32api

                    try:
                        info = win32api.GetFileVersionInfo(exe, "\\")
                        ms, ls = info["FileVersionMS"], info["FileVersionLS"]
                        version = "%d.%d.%d.%d" % (
                            ms >> 16,
                            ms & 0xFFFF,
                            ls >> 16,
                            ls & 0xFFFF,
                        )
                    except Exception:
                        version = ""
                processes.append({"pid": process.pid, "exe": exe, "version": version})
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        running = bool(processes)
        result = {
            "wechatRunning": running,
            "processes": processes,
            "ocrEnabled": bool(_CONFIG.get("enableOcr")),
            "python": sys.version.split()[0],
            "dbDir": _CONFIG.get("dbDir"),
        }
        if running:
            try:
                db = self.db()
                self_info = db.get_self_info() or {}
                result["account"] = {
                    "wxid": self_info.get("username") or getattr(db, "wxid", ""),
                    "nick": self_info.get("nick_name") or "",
                    "dbDir": getattr(db, "db_dir", ""),
                    "keyCount": len(getattr(db, "_keys", {}) or {}),
                }
                result["readable"] = bool(result["account"]["keyCount"])
            except Exception as error:
                result["readable"] = False
                result["dbError"] = "%s: %s" % (type(error).__name__, error)
        return result

    def m_self(self, params):
        db = self.db()
        info = db.get_self_info() or {}
        return {
            "wxid": info.get("username") or getattr(db, "wxid", ""),
            "nick": info.get("nick_name") or "",
        }

    def m_sessions(self, params):
        limit = int(params.get("limit") or 30)
        unread_only = bool(params.get("unreadOnly"))
        rows = self.db().get_sessions(limit=max(limit, 1) * 3 if unread_only else limit)
        out = []
        for row in rows:
            username = row.get("username") or ""
            unread = int(row.get("unread") or 0)
            if unread_only and unread <= 0:
                continue
            last_sender = row.get("last_sender") or ""
            if ":" in last_sender:
                last_sender = last_sender.rsplit(":", 1)[-1]
            out.append(
                {
                    "username": username,
                    "name": self.display_name(username),
                    "isGroup": username.endswith("@chatroom"),
                    "unread": unread,
                    "summary": (row.get("summary") or "")[:200],
                    "lastTime": row.get("last_time") or 0,
                    "lastTimeText": time.strftime(
                        "%Y-%m-%d %H:%M", time.localtime(row.get("last_time") or 0)
                    )
                    if row.get("last_time")
                    else "",
                    "lastSender": self.display_name(last_sender) if last_sender else "",
                }
            )
            if len(out) >= limit:
                break
        return {"sessions": out, "total": len(out)}

    def m_messages(self, params):
        chat = params.get("chat")
        if not chat:
            raise ValueError("必须给出 chat")
        limit = min(int(params.get("limit") or 20), int(_CONFIG.get("maxMessages") or 100))
        username, name = self.resolve_target(chat)
        if username is None:
            raise ValueError(
                "找不到会话「%s」：用 wechat_search 或 wechat_sessions 拿 username 再试" % chat
            )
        is_group = username.endswith("@chatroom")
        rows = self.db().get_messages(username, limit=limit)
        messages = [self.message_view(row, username, is_group) for row in rows]
        messages.sort(key=lambda item: (item["time"], item["id"] or 0))
        return {
            "chat": {"username": username, "name": name, "isGroup": is_group},
            "messages": messages,
            "count": len(messages),
        }

    def m_search(self, params):
        keyword = (params.get("keyword") or "").strip()
        if not keyword:
            raise ValueError("必须给出 keyword")
        results = []
        seen = set()
        try:
            for row in self.db().search_contact(keyword) or []:
                username = row.get("username") or ""
                if not username or username in seen:
                    continue
                seen.add(username)
                results.append(
                    {
                        "username": username,
                        "name": row.get("remark") or row.get("nick_name") or username,
                        "nick": row.get("nick_name") or "",
                        "remark": row.get("remark") or "",
                        "isGroup": username.endswith("@chatroom"),
                    }
                )
        except Exception as error:
            log("search_contact 失败：%s" % error)
        for username, name in self.name_map().items():
            if keyword in name and username not in seen:
                seen.add(username)
                results.append(
                    {
                        "username": username,
                        "name": name,
                        "nick": name,
                        "remark": "",
                        "isGroup": username.endswith("@chatroom"),
                    }
                )
            if len(results) >= 20:
                break
        return {"results": results[:20], "count": min(len(results), 20)}

    def m_send(self, params):
        chat = params.get("chat")
        text = params.get("text")
        if not chat:
            raise ValueError("必须给出 chat")
        if not isinstance(text, str) or not text.strip():
            raise ValueError("必须给出非空 text")
        dry_run = bool(params.get("dryRun"))
        username, name = self.resolve_target(chat)
        plan = {
            "chat": {"username": username, "name": name},
            "text": text,
            "dryRun": dry_run,
        }
        if dry_run:
            return dict(plan, ok=True, sent=False, note="dryRun：只解析目标，不发")
        started = time.time()
        gui = self.gui()
        # verify=False：库侧回读由本桥自己做（见下），避免 gui 自己起一个
        # WeChatDB 再解密一遍，白花十几秒。
        response = gui.send_msg(text, name or username, verify=False)
        ok = bool(response)
        message = ""
        try:
            message = response.get("message", "")
        except Exception:
            message = str(response)
        result = dict(
            plan,
            ok=ok,
            sent=ok,
            uiaMessage=message,
            elapsedMs=int((time.time() - started) * 1000),
        )
        # 回读确认：缓存可能滞后，强制重建一次读取器再等。
        confirmed = self._confirm_sent(username, name, text)
        result["confirmed"] = confirmed
        self._log_outbox(username, name, text, ok, confirmed)
        return result

    def _confirm_sent(self, username, name, text, target=None):
        deadline = time.time() + float(_CONFIG.get("confirmSec") or 12)
        attempts = 0
        while time.time() < deadline:
            attempts += 1
            try:
                db = self.db()
                if hasattr(db, "_invalidate_cache"):
                    db._invalidate_cache()
                rows = db.get_messages(target or username, limit=6)
                for row in rows:
                    content = row.get("content") or ""
                    if isinstance(content, str) and text.strip() and text.strip() in content:
                        if (row.get("sender_username") or "") == getattr(db, "wxid", ""):
                            return True
            except Exception as error:
                log("发送回读失败（第 %d 次）：%s" % (attempts, error))
            time.sleep(1.5)
        return False

    def _log_outbox(self, username, name, text, ok, confirmed):
        record = {
            "at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "username": username,
            "name": name,
            "text": text,
            "ok": ok,
            "confirmed": confirmed,
        }
        try:
            with open(os.path.join(_STATE_DIR, "outbox.jsonl"), "a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        except Exception as error:
            log("outbox 写入失败：%s" % error)

    def m_poll(self, params):
        """拉取「上次之后的新消息」，并推进游标。

        这是自动回复的入口：调用方只看到真正没处理过的、别人发来的消息。

        首次遇到某个会话时**只建基线、不返回历史**——否则第一次调用会把最近
        30 条旧消息全当新消息推出去，变成对陈年旧事逐条回复。
        """
        limit = int(params.get("limit") or 50)
        chats = params.get("chats") or []
        deep = bool(params.get("deep"))
        watermarks = self._state.setdefault("watermarks", {})
        seen = set(self._state.setdefault("seen", [])[-400:])
        db = self.db()
        if chats:
            targets = []
            for chat in chats:
                username, name = self.resolve_target(chat)
                if username:
                    targets.append((username, name))
        else:
            # 默认只看有未读的会话：几十个会话全扫一遍要十几秒，没必要。
            targets = []
            for row in db.get_sessions(limit=40):
                username = row.get("username") or ""
                if not username:
                    continue
                if deep or int(row.get("unread") or 0) > 0:
                    targets.append((username, self.display_name(username)))
        collected = []
        for username, name in targets:
            is_group = username.endswith("@chatroom")
            try:
                rows = db.get_messages(username, limit=30)
            except Exception as error:
                log("读取 %s 失败：%s" % (name, error))
                continue
            ordered = sorted(rows, key=lambda item: item.get("create_time") or 0)
            if username not in watermarks:
                # 第一次看见这个会话：把游标落在最新一条，历史一律不推送。
                if ordered:
                    watermarks[username] = float(ordered[-1].get("create_time") or 0)
                continue
            watermark = float(watermarks.get(username) or 0)
            newest = watermark
            for row in ordered:
                created = float(row.get("create_time") or 0)
                key = "%s:%s:%s" % (username, row.get("shard"), row.get("local_id"))
                if key in seen:
                    newest = max(newest, created)
                    continue
                if created <= watermark:
                    continue
                view = self.message_view(row, username, is_group)
                newest = max(newest, created)
                if view["isSelf"]:
                    continue
                view["chat"] = {"username": username, "name": name, "isGroup": is_group}
                collected.append(view)
                seen.add(key)
            if newest > watermark:
                watermarks[username] = newest
        self._state["seen"] = list(seen)[-400:]
        _save_state(self._state)
        collected.sort(key=lambda item: item["time"])
        return {
            "messages": collected[:limit],
            "count": min(len(collected), limit),
            "window": self.active_window(),
            "proactive": self.proactive_status(chats),
        }

    # ------------------------------------------------------------ 发言时段
    @staticmethod
    def _clock_minutes(value):
        """'07:00' → 420；解析不了返回 None。"""
        try:
            hour, minute = str(value).split(":")[:2]
            hour, minute = int(hour), int(minute)
            if 0 <= hour <= 24 and 0 <= minute < 60:
                return hour * 60 + minute
        except Exception:
            pass
        return None

    def active_window(self):
        """现在是不是「允许说话」的时段。

        时段可以跨午夜（``07:00``–``01:00`` 就是次日 1 点）：起点大于终点时
        按「或」判断。这是**硬闸门**——不在时段内既不回消息、也不主动发言，
        所以提示里的其它规则都得先过这一关。
        """
        spec = ["00:00", "23:59"]
        try:
            with open(os.path.join(_STATE_DIR, "autoreply.json"), "r", encoding="utf-8") as handle:
                config = json.load(handle)
            candidate = config.get("activeWindow")
            if isinstance(candidate, list) and len(candidate) == 2:
                spec = [str(candidate[0]), str(candidate[1])]
        except Exception:
            pass
        start, end = self._clock_minutes(spec[0]), self._clock_minutes(spec[1])
        now = time.localtime()
        current = now.tm_hour * 60 + now.tm_min
        if start is None or end is None:
            return {
                "allowed": True,
                "window": spec,
                "now": time.strftime("%H:%M"),
                "reason": "时段配置无效，按全天放行",
            }
        inside = (start <= current <= end) if start <= end else (current >= start or current <= end)
        return {
            "allowed": inside,
            "window": spec,
            "now": time.strftime("%H:%M"),
            "reason": "ok" if inside else "不在发言时段（%s-%s）" % (spec[0], spec[1]),
        }

    # ------------------------------------------------------------ 主动发言闸门
    def proactive_status(self, chats):
        """算「现在能不能主动发一句」。

        没人说话时也要发言，所以必须有节流，否则 5 分钟一条会被当机器人踢掉。
        判据全部从磁盘上的事实来：

        * ``proactive.json``  —— 间隔、日上限、时间窗
        * ``outbox.jsonl``    —— wechat_send 每次真实发送都写一条，这就是账本

        不看模型记忆，也不需要在提示里记任何计数器。
        """
        config = {}
        try:
            with open(os.path.join(_STATE_DIR, "proactive.json"), "r", encoding="utf-8") as handle:
                config = json.load(handle)
        except FileNotFoundError:
            return {"enabled": False, "allowed": False, "reason": "未配置 proactive.json"}
        except Exception as error:
            return {"enabled": False, "allowed": False, "reason": "配置读取失败：%s" % error}

        enabled = bool(config.get("enabled"))
        min_gap = int(config.get("minMinutesBetween") or 90)
        daily_cap = int(config.get("dailyCap") or 6)
        recent_avoid = int(config.get("recentAvoid") or 5)
        targets = {chat for chat in (chats or []) if isinstance(chat, str)}
        gate = self.active_window()
        in_window = gate["allowed"]

        now = time.time()

        entries = []
        try:
            with open(os.path.join(_STATE_DIR, "outbox.jsonl"), "r", encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entries.append(json.loads(line))
                    except Exception:
                        continue
        except FileNotFoundError:
            pass

        mine = [
            entry
            for entry in entries
            if entry.get("ok") and (not targets or entry.get("username") in targets)
        ]
        last_at = 0.0
        last_text = ""
        if mine:
            last = mine[-1]
            last_text = last.get("text") or ""
            try:
                last_at = time.mktime(time.strptime(last.get("at", ""), "%Y-%m-%d %H:%M:%S"))
            except Exception:
                last_at = 0.0
        minutes_since = int((now - last_at) // 60) if last_at else None
        today = time.strftime("%Y-%m-%d")
        today_count = sum(1 for entry in mine if str(entry.get("at", "")).startswith(today))
        recent = [entry.get("text", "") for entry in mine[-recent_avoid:]]

        allowed = True
        reason = "ok"
        if not enabled:
            allowed, reason = False, "主动发言已关闭"
        elif not in_window:
            allowed, reason = False, gate["reason"]
        elif today_count >= daily_cap:
            allowed, reason = False, "今日已达上限（%d/%d）" % (today_count, daily_cap)
        elif minutes_since is not None and minutes_since < min_gap:
            allowed, reason = False, "冷却中（距上次 %d 分钟，需 %d）" % (minutes_since, min_gap)

        return {
            "enabled": enabled,
            "allowed": allowed,
            "reason": reason,
            "lastPostAt": time.strftime("%Y-%m-%d %H:%M", time.localtime(last_at)) if last_at else "",
            "lastPostText": last_text,
            "minutesSinceLastPost": minutes_since if minutes_since is not None else -1,
            "minMinutesBetween": min_gap,
            "todayCount": today_count,
            "dailyCap": daily_cap,
            "recentTexts": recent,
        }

    def m_seen(self, params):
        """只推进游标、不返回内容：用于「这条我已经知道了」的确认。"""
        chats = params.get("chats") or []
        watermarks = self._state.setdefault("watermarks", {})
        db = self.db()
        for chat in chats:
            username, _ = self.resolve_target(chat)
            if not username:
                continue
            rows = db.get_messages(username, limit=1)
            if rows:
                watermarks[username] = float(rows[0].get("create_time") or 0)
        _save_state(self._state)
        return {"watermarks": watermarks}

    def dispatch(self, method, params):
        handler = getattr(self, "m_" + str(method), None)
        if handler is None:
            raise ValueError("未知方法：%s" % method)
        return handler(params or {})


def main():
    bridge = Bridge()
    log("sidecar 就绪（python %s）" % sys.version.split()[0])
    while True:
        line = sys.stdin.readline()
        if not line:
            log("stdin 关闭，退出")
            return 0
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            result = bridge.dispatch(request.get("method"), request.get("params"))
            payload = {"id": request_id, "ok": True, "result": result}
        except Exception as error:
            payload = {
                "id": request_id,
                "ok": False,
                "error": "%s: %s" % (type(error).__name__, error),
                "trace": traceback.format_exc()[-1500:],
            }
        _PROTOCOL_OUT.write(
            (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
        )
        _PROTOCOL_OUT.flush()


if __name__ == "__main__":
    sys.exit(main() or 0)
