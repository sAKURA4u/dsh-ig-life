#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ig-bridge — the only part of dsh-ig-life that speaks Instagram's private API.

Why a separate process:

  * the official Graph API only serves Creator/Business accounts. A normal
    personal account has no official messaging API at all;
  * the private API (instagrapi) needs a real password and a real session
    cookie. Those must never enter the Node process, its config, its logs, or
    an LLM prompt.

So this sidecar owns the credentials and the session, listens on 127.0.0.1
only, and demands a shared token. `lib/transport/unofficial.js` is nothing but
an HTTP client for it.

    python src/ig_bridge.py --login          # first time: log in, dump the session
    python src/ig_bridge.py                  # serve on http://127.0.0.1:8737
    python src/ig_bridge.py --print-token    # show the shared token
    python src/ig_bridge.py --health

⚠️ This violates Instagram's terms. The account can be banned, at any time,
for no stated reason. Use an account you can afford to lose. Nothing here
promises that the private API keeps working — when Instagram changes its
signing, only an instagrapi release can fix it, and it may take days.
"""

from __future__ import annotations

import argparse
import hmac
import json
import logging
import os
import random
import secrets
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8737
MIN_POLL_SECONDS = 10          # below this a human app would never poll; do not go lower
MAX_BODY_BYTES = 1 << 20
LOGIN_BACKOFF_SECONDS = 600    # a crash loop must never become a login storm
SEEN_ID_MEMORY = 600
MAX_THREADS_PER_POLL = 6
MESSAGES_PER_THREAD = 15
FIRST_SIGHT_MESSAGES = 3      # a thread seen for the first time must not dump its history
USER_LOOKUPS_PER_POLL = 3      # extra private-API calls to learn a username, bounded

log = logging.getLogger("ig-bridge")


# --------------------------------------------------------------------------- errors
class BridgeError(Exception):
    """A failure with a code and a next step — never a bare traceback."""

    def __init__(self, code: str, message: str, hint: str = "", status: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint
        self.status = status

    def payload(self) -> dict:
        return {"ok": False, "code": self.code, "error": self.message, "hint": self.hint}


def _map_exception(error: Exception) -> "BridgeError":
    """
    instagrapi's exception classes move between releases, so map by class name.
    A wrong class name would break the import; a string comparison cannot.
    """
    if isinstance(error, BridgeError):
        return error
    name = type(error).__name__
    message = str(error) or name
    if name in ("ChallengeRequired", "ChallengeError", "ChallengeUnknownStep"):
        return BridgeError(
            "IG_CHALLENGE_REQUIRED",
            "Instagram 要求驗證呢次登入：" + message,
            "打開 Instagram app／網頁按「呢個係我」批准，再跑 python src/ig_bridge.py --login",
            403,
        )
    if name in ("TwoFactorRequired", "TwoFactorRequiredError"):
        return BridgeError(
            "IG_2FA_REQUIRED",
            "呢個帳號開了兩步驗證：" + message,
            "非官方 sidecar 不支援 2FA。先在 IG 關掉兩步驗證（或用一個細號），或者改用官方 graph transport",
            403,
        )
    if name in ("LoginRequired", "ClientUnauthorizedError", "ClientLoginRequiredError"):
        return BridgeError(
            "IG_LOGIN_REQUIRED",
            "session 已失效：" + message,
            "跑 python src/ig_bridge.py --login 重新登入（會先重用 session 檔，唔會亂 login）",
            401,
        )
    if name in ("PleaseWaitFewMinutes", "RateLimitError", "ClientThrottledError", "YouHaveBeenLoggedOut"):
        return BridgeError(
            "IG_RATE_LIMIT",
            "Instagram 限流：" + message,
            "停手最少半個鐘，然後調高 unofficial.pollSeconds、降低 sendPerDay；連續撞牆會直接封號",
            429,
        )
    if name in ("ProxyAddressIsBlocked", "ProxyError"):
        return BridgeError(
            "IG_PROXY_BLOCKED",
            "Instagram 封鎖了這個 IP／代理：" + message,
            "換網絡環境，或者停一日再試；不要用免費代理",
            403,
        )
    if name in ("UserNotFound", "MediaNotFound", "DirectThreadNotFound", "CommentNotFound", "NotFound", "UserInvalid"):
        return BridgeError(
            "IG_NOT_FOUND",
            "搵唔到對象：" + message,
            "確認 thread_id／media_id；對方封鎖了你、或者刪了訊息都會這樣",
            404,
        )
    if name in ("MediaUploadError", "VideoUploadError", "PhotoUploadError"):
        return BridgeError(
            "IG_UPLOAD_FAILED",
            "上傳失敗：" + message,
            "檢查檔案格式（jpg/png、m4a）、大小，以及圖片是否在 media-root 之內",
            502,
        )
    if name in ("ClientError", "ClientBadRequestError", "ClientConnectionError"):
        return BridgeError(
            "IG_UPSTREAM",
            "Instagram 拒絕了請求：" + message,
            "非官方私有 API 隨時會改；如果每次都一樣，就是 instagrapi 要更新了",
            502,
        )
    return BridgeError(
        "IG_UNOFFICIAL_ERROR",
        f"{name}: {message}",
        "非官方私有 API 沒有保證；壞了要等 instagrapi 修。細節看 sidecar 的輸出",
        502,
    )


# ------------------------------------------------------------------------- helpers
def dsh_home() -> Path:
    raw = str(os.environ.get("DSH_HOME") or "").strip()
    return Path(raw).expanduser() if raw else Path.home() / ".dsh"


def resolve_data_dir(configured: str = "") -> Path:
    raw = str(configured or os.environ.get("IG_LIFE_DATA_DIR") or "").strip()
    return Path(raw).expanduser() if raw else dsh_home() / "ig-life"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _day_key() -> str:
    return time.strftime("%Y-%m-%d")


def _to_epoch(value) -> float:
    if value is None:
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, datetime):
        moment = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return moment.timestamp()
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return 0.0
        try:
            return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return 0.0
    return 0.0


def _iso(value) -> str:
    epoch = _to_epoch(value)
    if epoch <= 0:
        return _now_iso()
    return datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _get(obj, key, default=None):
    """Read a field from either a dict or an instagrapi model object."""
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _dig(obj, *keys):
    for key in keys:
        obj = _get(obj, key)
        if obj is None:
            return None
    return obj


def _first(*values):
    for value in values:
        if value:
            return value
    return ""


def _as_int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def load_json(path: Path, default):
    try:
        # utf-8-sig: Windows PowerShell 5.1's `Set-Content -Encoding utf8` writes
        # a BOM, and a BOM makes json.loads raise. Tolerate it silently.
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return default
    except (OSError, ValueError) as error:
        quarantine = path.with_name(path.name + f".corrupt-{int(time.time())}")
        try:
            path.rename(quarantine)
            log.warning("%s 讀不了（%s），已搬到 %s", path.name, error, quarantine.name)
        except OSError:
            log.warning("%s 讀不了（%s）", path.name, error)
        return default


def secure_write(path: Path, text: str) -> None:
    """Atomic write with 0600 from the first byte — session cookies go here."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    descriptor = os.open(str(temp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(text)
    os.replace(temp, path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def load_or_create_token(data_dir: Path, explicit: str = "") -> str:
    """
    The Node transport reads the same `<dataDir>/sidecar-token` file, so the two
    processes share a secret without a copy-paste step in any config.
    """
    if str(explicit or "").strip():
        return str(explicit).strip()
    from_env = str(os.environ.get("IG_LIFE_SIDECAR_TOKEN") or "").strip()
    if from_env:
        return from_env
    path = data_dir / "sidecar-token"
    try:
        existing = path.read_text(encoding="utf-8").strip()
    except OSError:
        existing = ""
    if existing:
        return existing
    token = secrets.token_hex(24)
    secure_write(path, token + "\n")
    return token


def _instagrapi():
    try:
        import instagrapi  # noqa: PLC0415 — imported lazily so --print-token needs no deps
    except ImportError as error:  # pragma: no cover - depends on the host
        raise BridgeError(
            "IG_SIDECAR_NO_DEPS",
            "instagrapi 未安裝：" + str(error),
            "python -m pip install -r src/requirements.txt",
            503,
        )
    return instagrapi


def _image_url(media) -> str:
    candidates = _dig(media, "image_versions2", "candidates")
    if isinstance(candidates, list) and candidates:
        url = _get(candidates[0], "url")
        if url:
            return str(url)
    for shape in (("thumbnail_url",), ("display_url",), ("images", "fixed_height", "url"), ("images", "fixed_height_small", "url")):
        url = _dig(media, *shape)
        if url:
            return str(url)
    return ""


def _video_url(media) -> str:
    videos = _dig(media, "video_versions")
    if isinstance(videos, list) and videos:
        url = _get(videos[0], "url")
        if url:
            return str(url)
    url = _dig(media, "video_url")
    return str(url) if url else ""


def _shortcode_url(code: str) -> str:
    return f"https://www.instagram.com/p/{code}/" if code else ""


def _attachment(kind: str, url: str = "", media_id: str = "") -> dict:
    payload: dict = {}
    if url:
        payload["url"] = url
    if media_id:
        payload["media_id"] = str(media_id)
    return {"type": kind, "payload": payload}


def _share_attachment(message) -> dict:
    code = _first(
        _dig(message, "clip", "code"),
        _dig(message, "media", "code"),
        _dig(message, "reel_share", "code"),
        _dig(message, "story_share", "media", "code"),
    )
    media_id = _first(
        _dig(message, "clip", "id"),
        _dig(message, "media", "id"),
        _dig(message, "reel_share", "media_id"),
        _dig(message, "media_share", "id"),
    )
    return _attachment("share", _shortcode_url(str(code)) if code else "", media_id)


def normalise_message(message, thread_id: str, users: dict, me_id: int):
    """
    One instagrapi DirectMessage → the event shape the Node bridge already knows.
    Returns None for our own messages and for entries with nothing to say.
    """
    sender_id = _as_int(_get(message, "user_id"), 0)
    if me_id and sender_id == me_id:
        return None
    item_type = str(_get(message, "item_type", "") or "").lower()
    if item_type in ("action_log", "like", "placeholder", "video_call_event", "reaction_log", "reaction", "deprecated"):
        return None

    text = str(_get(message, "text", "") or "")
    attachments: list = []

    if item_type in ("media", "raven_media", "video"):
        media = _get(message, "raven_media") or _get(message, "media")
        media_type = _as_int(_get(media, "media_type"), 1)
        if media_type == 2:
            attachments.append(_attachment("video", _video_url(media) or _image_url(media), _get(media, "id", "")))
        else:
            attachments.append(_attachment("image", _image_url(media), _get(media, "id", "")))
    elif item_type == "voice_media":
        media = _get(message, "voice_media") or _get(message, "media")
        audio = _dig(media, "audio", "url") or _dig(media, "audio_url") or _get(media, "url")
        attachments.append(_attachment("audio", str(audio) if audio else "", _get(media, "id", "")))
    elif item_type == "animated_media":
        media = _get(message, "animated_media") or _get(message, "media")
        attachments.append(_attachment("sticker", _image_url(media), _get(media, "id", "")))
    elif item_type in ("reel_share", "clip", "media_share", "story_share", "felix_share", "profile"):
        attachments.append(_share_attachment(message))
        if not text:
            text = str(_dig(message, "text") or "")
            if not text and item_type == "story_share":
                text = "（分享了一個 story）"
    elif item_type == "link":
        url = _first(_dig(message, "link", "url"), _dig(message, "link", "text"))
        attachments.append(_attachment("share", str(url) if url else ""))
        if not text and url:
            text = str(url)
    elif item_type != "text" and not text:
        # Unknown item type with no text: tell the truth rather than invent one.
        attachments.append(_attachment(str(item_type or "unknown")))

    if not text.strip() and not attachments:
        return None

    return {
        "id": str(_get(message, "id", "") or ""),
        "threadId": str(thread_id),
        "senderId": str(sender_id or ""),
        "userId": str(sender_id or ""),
        "username": users.get(sender_id, "") or "",
        "text": text,
        "at": _iso(_get(message, "timestamp")),
        "attachments": attachments,
        "isEcho": False,
    }


# --------------------------------------------------------------------------- bridge
class Bridge:
    """Holds the only logged-in client, and the pace at which Instagram is touched."""

    def __init__(self, data_dir: Path, *, poll_seconds: int = 20, send_per_day: int = 30,
                 post_per_day: int = 2, media_roots=None):
        self.data_dir = data_dir
        self.poll_seconds = max(MIN_POLL_SECONDS, _as_int(poll_seconds, 20))
        self.send_per_day = max(0, _as_int(send_per_day, 30))
        self.post_per_day = max(0, _as_int(post_per_day, 2))
        roots = list(media_roots or [])
        if not roots:
            roots = [data_dir]
        self.media_roots = [Path(root).expanduser().resolve() for root in roots]

        self._lock = threading.RLock()          # protects bookkeeping state
        self._api_lock = threading.RLock()      # instagrapi is not thread-safe
        self._client = None
        self._username = ""
        self._session_note = "unknown"
        self._usernames = {}
        self._last_poll_at = 0.0
        self._cache = {"messages": [], "cursor": None, "fetchedAt": None}
        self._state = self._load_state()

    # ---- state -----------------------------------------------------------
    def _state_path(self) -> Path:
        return self.data_dir / "ig-bridge-state.json"

    def _load_state(self) -> dict:
        loaded = load_json(self._state_path(), {}) or {}
        return {
            "day": str(loaded.get("day") or ""),
            "sent": max(0, _as_int(loaded.get("sent"), 0)),
            "post": max(0, _as_int(loaded.get("post"), 0)),
            "seenIds": list(loaded.get("seenIds") or [])[-SEEN_ID_MEMORY:],
            "threads": dict(loaded.get("threads") or {}),
        }

    def _save_state(self) -> None:
        with self._lock:
            state = dict(self._state)
            state["seenIds"] = list(state.get("seenIds") or [])[-SEEN_ID_MEMORY:]
            secure_write(self._state_path(), json.dumps(state, ensure_ascii=False, indent=2) + "\n")

    def _roll_day(self) -> dict:
        with self._lock:
            state = self._state
            today = _day_key()
            if state.get("day") != today:
                state["day"] = today
                state["sent"] = 0
                state["post"] = 0
            return state

    def check_cap(self, kind: str) -> None:
        """A second ceiling, below the Node one — so a stray curl cannot burn the account either."""
        state = self._roll_day()
        if kind == "post":
            if state["post"] >= self.post_per_day:
                raise BridgeError(
                    "IG_DAILY_CAP",
                    f"今日已發 {state['post']} 篇帖（sidecar 上限 {self.post_per_day}）",
                    "調高 --post-per-day 有風險；IG 對新帳號突然活躍很敏感",
                    429,
                )
            state["post"] += 1
        else:
            if state["sent"] >= self.send_per_day:
                raise BridgeError(
                    "IG_DAILY_CAP",
                    f"今日已發 {state['sent']} 則訊息（sidecar 上限 {self.send_per_day}）",
                    "等明日；非官方帳號最忌密集發訊",
                    429,
                )
            state["sent"] += 1
        self._save_state()

    # ---- credentials + session -------------------------------------------
    def _credentials(self):
        secret_file = self.data_dir / "ig-secrets.json"
        data = load_json(secret_file, {}) or {}
        username = str(data.get("username") or os.environ.get("IG_USERNAME") or "").strip().lstrip("@")
        password = str(data.get("password") or os.environ.get("IG_PASSWORD") or "")
        if not username or not password:
            raise BridgeError(
                "IG_NO_CREDENTIALS",
                "未找到 IG 帳號密碼",
                f'跑 python src/ig_bridge.py --set-credentials（互動輸入，不會回顯）；或手動寫入 {secret_file} 並設為 0600',
                503,
            )
        try:
            if secret_file.exists() and (secret_file.stat().st_mode & 0o077):
                log.warning("ig-secrets.json 權限太寬（%o）—— 建議 chmod 600", secret_file.stat().st_mode & 0o777)
        except OSError:
            pass
        return username, password

    def _session_meta(self) -> dict:
        return load_json(self.data_dir / "ig-session-meta.json", {}) or {}

    def _remember(self, client, username: str, session: str) -> None:
        self._client = client
        self._username = username
        self._session_note = session
        meta = {
            "username": username,
            "session": session,
            "at": _now_iso(),
            "freshLoginAt": self._session_meta().get("freshLoginAt") if session != "fresh" else time.time(),
        }
        if session == "fresh":
            meta["freshLoginAt"] = time.time()
        secure_write(self.data_dir / "ig-session-meta.json", json.dumps(meta, ensure_ascii=False, indent=2) + "\n")
        log.info("session %s（@%s）", session, username)

    def ensure_client(self, force_relogin: bool = False):
        with self._api_lock:
            if self._client is not None and not force_relogin:
                return self._client
            return self._login(force_relogin=force_relogin)

    def _login(self, force_relogin: bool = False):
        ig = _instagrapi()
        username, password = self._credentials()
        session_file = self.data_dir / "ig-session.json"
        meta = self._session_meta()
        fresh_at = float(meta.get("freshLoginAt") or 0)

        def make_client():
            client = ig.Client()
            # instagrapi's own randomised pause between private requests. Leaving
            # this at zero is the difference between "a human app" and "a bot".
            try:
                client.delay_range = [1.5, 4.0]
            except Exception:  # pragma: no cover - version differences
                pass
            try:
                client.request_timeout = 30
            except Exception:  # pragma: no cover
                pass
            return client

        resumed = False
        if session_file.exists() and not force_relogin:
            client = make_client()
            try:
                client.load_settings(str(session_file))
                # `login()` after `load_settings()` reuses the sessionid cookie.
                # It does not open a new login request, which is the whole point.
                client.login(username, password)
                if not getattr(client, "user_id", None):
                    raise BridgeError("IG_LOGIN_REQUIRED", "session 重用之後仍未登入", "", 401)
                resumed = True
            except Exception as error:
                mapped = _map_exception(error)
                log.warning("session 重用失敗：%s %s", mapped.code, mapped.message)
                if mapped.code not in ("IG_LOGIN_REQUIRED",):
                    raise mapped
                resumed = False
        if resumed:
            self._remember(client, username, "reused")
            self._refresh_session_file(client)
            return client

        if not force_relogin and fresh_at and (time.time() - fresh_at) < LOGIN_BACKOFF_SECONDS:
            wait = int(LOGIN_BACKOFF_SECONDS - (time.time() - fresh_at))
            raise BridgeError(
                "IG_LOGIN_BACKOFF",
                f"{wait} 秒前才剛剛重新登入過，唔會再登入一次",
                "每次全新登入都係最大嘅封號觸發點；等一陣，或者跑 --relogin 明確表示要重新登入",
                429,
            )

        client = make_client()
        try:
            client.login(username, password)
        except Exception as error:
            raise _map_exception(error)
        self._remember(client, username, "fresh")
        self._refresh_session_file(client)
        return client

    def _refresh_session_file(self, client) -> None:
        try:
            settings = client.get_settings()
        except Exception as error:  # pragma: no cover - only on a broken client
            log.warning("拎唔到 session settings：%s", error)
            return
        secure_write(self.data_dir / "ig-session.json", json.dumps(settings, ensure_ascii=False))

    # ---- inbound ----------------------------------------------------------
    def poll(self) -> dict:
        with self._api_lock:
            now = time.monotonic()
            with self._lock:
                if self._last_poll_at and (now - self._last_poll_at) < self.poll_seconds:
                    # Delivered messages are already marked as seen; a throttle
                    # answers "nothing new", never a replay of the last batch.
                    cached = dict(self._cache)
                    cached.update({"ok": True, "messages": [], "throttled": True})
                    return cached
                self._last_poll_at = now

            client = self.ensure_client()
            me_id = _as_int(getattr(client, "user_id", 0) or 0, 0)
            try:
                threads = client.direct_threads(amount=MAX_THREADS_PER_POLL)
            except Exception as error:
                raise _map_exception(error)
            if not isinstance(threads, list):
                threads = []

            seen = set(self._state.get("seenIds") or [])
            known_threads = dict(self._state.get("threads") or {})
            collected: list = []
            skipped_groups = 0
            touched: dict = {}
            cutoff = time.time() - 7 * 86400

            for thread in threads[:MAX_THREADS_PER_POLL]:
                if bool(_get(thread, "is_group", False)):
                    skipped_groups += 1
                    continue
                thread_id = str(_first(_get(thread, "id"), _get(thread, "thread_id")))
                if not thread_id:
                    continue
                activity = _to_epoch(_get(thread, "last_activity_at", None))
                last_seen = float(known_threads.get(thread_id) or 0)
                if activity and last_seen and activity <= last_seen + 0.5:
                    continue
                if activity and activity < cutoff:
                    continue
                try:
                    messages = client.direct_messages(thread_id, amount=MESSAGES_PER_THREAD)
                except Exception as error:
                    log.warning("讀 thread %s 失敗：%s", thread_id, error)
                    continue
                users = {}
                for user in _get(thread, "users", None) or []:
                    users[_as_int(_get(user, "pk"), 0)] = str(_get(user, "username", "") or "")

                # A thread can arrive without its user list. Without a username
                # the allowlist cannot match anyone, so resolve a few senders per
                # poll (bounded on purpose: this is an extra private-API call).
                unknown = []
                for message in messages or []:
                    sender = _as_int(_get(message, "user_id"), 0)
                    if sender and not users.get(sender) and sender not in unknown:
                        unknown.append(sender)
                for sender in unknown[:USER_LOOKUPS_PER_POLL]:
                    if self._usernames.get(sender):
                        users[sender] = self._usernames[sender]
                        continue
                    try:
                        info = client.user_info(sender)
                        name = str(_get(info, "username", "") or "")
                    except Exception as error:
                        log.debug("查詢 @%s 失敗：%s", sender, error)
                        continue
                    if name:
                        users[sender] = name
                        self._usernames[sender] = name
                if len(self._usernames) > 500:
                    self._usernames.clear()

                items = [
                    item
                    for item in (normalise_message(message, thread_id, users, me_id) for message in messages or [])
                    if item is not None and item["id"] and item["id"] not in seen
                ]
                # First sight of a thread must not dump a week of history into one
                # burst of replies: keep the newest few, then follow activity.
                if not last_seen and len(items) > FIRST_SIGHT_MESSAGES:
                    items = items[-FIRST_SIGHT_MESSAGES:]
                for item in items:
                    seen.add(item["id"])
                    collected.append(item)
                if activity:
                    touched[thread_id] = activity

            with self._lock:
                state = self._roll_day()
                state["seenIds"] = list(state.get("seenIds") or []) + [item["id"] for item in collected]
                state["seenIds"] = state["seenIds"][-SEEN_ID_MEMORY:]
                for thread_id, activity in touched.items():
                    state["threads"][thread_id] = activity
                # keep the thread table small
                if len(state["threads"]) > 200:
                    newest = sorted(state["threads"].items(), key=lambda pair: pair[1], reverse=True)[:200]
                    state["threads"] = dict(newest)
                self._cache = {
                    "messages": collected,
                    "cursor": collected[-1]["at"] if collected else self._cache.get("cursor"),
                    "fetchedAt": _now_iso(),
                }
                self._save_state()

            return {
                "ok": True,
                "messages": collected,
                "cursor": self._cache["cursor"],
                "throttled": False,
                "skippedGroups": skipped_groups,
                "fetchedAt": self._cache["fetchedAt"],
            }

    # ---- outbound ---------------------------------------------------------
    def _target(self, payload: dict) -> dict:
        thread_id = str(payload.get("threadId") or "").strip()
        user_id = str(payload.get("userId") or "").strip()
        username = str(payload.get("username") or "").strip().lstrip("@")
        if not (thread_id or user_id or username):
            raise BridgeError(
                "IG_NO_RECIPIENT",
                "沒有收件人（threadId / userId / username 都是空）",
                "第一次主動找一個陌生人，IG 只接受 username 或 user id；thread id 要對方先私訊過你",
                400,
            )
        target = {}
        if thread_id:
            target["thread_ids"] = [thread_id]
        elif user_id:
            target["user_ids"] = [int(user_id)] if user_id.isdigit() else [user_id]
        else:
            target["usernames"] = [username]
        return target

    def _message_id(self, result) -> str:
        first = result[0] if isinstance(result, list) and result else result
        return str(_get(first, "id", "") or "")

    def _thread_id_of(self, result) -> str:
        first = result[0] if isinstance(result, list) and result else result
        return str(_first(_get(first, "thread_id"), _get(first, "threadId")) or "")

    def send(self, payload: dict) -> dict:
        text = str(payload.get("text") or "").strip()
        if not text:
            raise BridgeError("IG_EMPTY_MESSAGE", "空訊息", "寫點東西再發", 400)
        with self._api_lock:
            client = self.ensure_client()
            self.check_cap("dm")
            target = self._target(payload)
            try:
                result = client.direct_send(text, **target)
            except Exception as error:
                raise _map_exception(error)
        return {
            "ok": True,
            "id": self._message_id(result),
            "threadId": str(payload.get("threadId") or "") or self._thread_id_of(result) or None,
            "username": payload.get("username") or None,
        }

    def _resolve_media_path(self, raw: str) -> Path:
        candidate = Path(str(raw or "")).expanduser()
        if not candidate.is_absolute():
            candidate = self.data_dir / candidate
        try:
            candidate = candidate.resolve()
        except OSError:
            pass
        if not candidate.is_file():
            raise BridgeError(
                "IG_MEDIA_NOT_FOUND",
                f"檔案找不到：{candidate}",
                "只有 sidecar 讀得到的本機檔案才傳得出去；DSH 同 sidecar 要跑在同一部機、同一個使用者",
                404,
            )
        allowed = any(candidate == root or root in candidate.parents for root in self.media_roots)
        if not allowed:
            raise BridgeError(
                "IG_MEDIA_ROOT",
                f"{candidate} 不在允許的資料夾之內",
                "用 --media-root 指定可上傳的資料夾（預設只有 <dataDir>）；這樣才不會誤把整部機的檔案傳上 IG",
                403,
            )
        return candidate

    def send_media(self, payload: dict) -> dict:
        kind = str(payload.get("type") or "image").lower()
        if kind not in ("image", "audio", "video", "file"):
            raise BridgeError("IG_BAD_ATTACHMENT_TYPE", f"不支援的附件類型：{kind}", "image / audio / video / file", 400)
        path = self._resolve_media_path(str(payload.get("path") or ""))
        text = str(payload.get("text") or "").strip()
        with self._api_lock:
            client = self.ensure_client()
            self.check_cap("media")
            target = self._target(payload)
            mode = kind
            try:
                if kind == "image":
                    if not hasattr(client, "direct_send_photo"):
                        raise BridgeError("IG_UNSUPPORTED", "這個 instagrapi 版本沒有 direct_send_photo", "更新 instagrapi", 501)
                    result = client.direct_send_photo(str(path), **target)
                elif kind == "video":
                    result = client.direct_send_video(str(path), **target)
                elif kind == "audio":
                    # A voice note needs m4a/opus. An mp3 falls back to a file
                    # attachment — better an honest file than a fake voice note.
                    try:
                        result = client.direct_send_voice(str(path), **target)
                        mode = "voice"
                    except Exception as voice_error:
                        mapped = _map_exception(voice_error)
                        if mapped.code in ("IG_LOGIN_REQUIRED", "IG_RATE_LIMIT", "IG_CHALLENGE_REQUIRED"):
                            raise mapped  # a dead session is not a format problem
                        log.info("direct_send_voice 失敗（%s），改為檔案附件", voice_error)
                        result = client.direct_send_file(str(path), **target)
                        mode = "file"
                else:
                    result = client.direct_send_file(str(path), **target)
            except BridgeError:
                raise
            except Exception as error:
                raise _map_exception(error)

            text_id = ""
            if text:
                self.check_cap("dm")
                try:
                    time.sleep(random.uniform(1.0, 2.5))
                    text_result = client.direct_send(text, **target)
                    text_id = self._message_id(text_result)
                except Exception as error:
                    raise _map_exception(error)
        return {"ok": True, "id": self._message_id(result), "textId": text_id, "mode": mode, "threadId": payload.get("threadId") or None}

    def post(self, payload: dict) -> dict:
        caption = str(payload.get("caption") or "").strip()
        if not caption:
            raise BridgeError("IG_EMPTY_CAPTION", "空 caption", "寫點東西再發", 400)
        path = self._resolve_media_path(str(payload.get("imagePath") or ""))
        with self._api_lock:
            client = self.ensure_client()
            self.check_cap("post")
            try:
                media = client.photo_upload(str(path), caption)
            except Exception as error:
                raise _map_exception(error)
        code = str(_get(media, "code", "") or "")
        return {
            "ok": True,
            "mediaId": str(_get(media, "pk", "") or _get(media, "id", "") or ""),
            "permalink": _shortcode_url(code),
        }

    def reply_comment(self, payload: dict) -> dict:
        text = str(payload.get("text") or "").strip()
        comment_id = str(payload.get("commentId") or "").strip()
        media_id = str(payload.get("mediaId") or "").strip()
        if not text:
            raise BridgeError("IG_EMPTY_MESSAGE", "空回覆", "寫點東西再回", 400)
        if not comment_id:
            raise BridgeError("IG_NO_COMMENT_ID", "缺少 commentId", "私有 API 要 comment id", 400)
        if not media_id:
            raise BridgeError(
                "IG_COMMENT_NEEDS_MEDIA",
                "回覆留言需要 mediaId",
                "instagram 私有 API 的留言回覆要 media id；unofficial 模式收不到留言事件，所以只有你手上有 media id 才用得到",
                400,
            )
        with self._api_lock:
            client = self.ensure_client()
            self.check_cap("comment")
            try:
                comment = client.media_comment(media_id, text, replied_to_comment_id=comment_id)
            except Exception as error:
                raise _map_exception(error)
        return {"ok": True, "id": str(_get(comment, "pk", "") or _get(comment, "id", "") or "")}

    # ---- credentials (the settings page's account section) ---------------
    def credentials_payload(self) -> dict:
        """
        What the page may know: whether a password is set, and the username.
        The password itself never leaves this process — not masked, not at all.
        """
        secret_file = self.data_dir / "ig-secrets.json"
        data = load_json(secret_file, {}) or {}
        username = str(data.get("username") or os.environ.get("IG_USERNAME") or "").strip().lstrip("@")
        has_password = bool(str(data.get("password") or os.environ.get("IG_PASSWORD") or ""))
        return {
            "ok": True,
            "hasCredentials": bool(username and has_password),
            "username": username or None,
            "file": str(secret_file),
        }

    def save_credentials(self, payload: dict) -> dict:
        username = str(payload.get("username") or "").strip().lstrip("@")
        password = str(payload.get("password") or "")
        if not username:
            raise BridgeError("IG_NO_CREDENTIALS", "username 不能空白", "填小號的 IG 使用者名稱（不用 @）", 400)
        if not password:
            # Blank password on a later save means "keep the stored one".
            existing = load_json(self.data_dir / "ig-secrets.json", {}) or {}
            password = str(existing.get("password") or "")
            if not password:
                raise BridgeError("IG_NO_CREDENTIALS", "password 不能空白", "第一次設定要輸入密碼；之後留空表示沿用舊密碼", 400)
        secure_write(
            self.data_dir / "ig-secrets.json",
            json.dumps({"username": username, "password": password}, ensure_ascii=False, indent=2) + "\n",
        )
        with self._api_lock:
            # A different account means the old client belongs to somebody else.
            if self._username and self._username.lower() != username.lower():
                self._client = None
                self._session_note = "unknown"
        log.info("credentials saved for @%s（密碼不會寫入 log）", username)
        return {"ok": True, "username": username, "hasCredentials": True}

    def login(self) -> dict:
        """Log in now if we are not already logged in. Reuses the session first."""
        with self._api_lock:
            if self._client is None:
                self.ensure_client()
            return self.health()

    # ---- health -----------------------------------------------------------
    def health(self) -> dict:
        # `_api_lock` first, then `_roll_day()` takes `_lock`: the same order as
        # `poll()`. Reversing it here would open a deadlock against a live poll.
        with self._api_lock:
            meta = self._session_meta()
            state = self._roll_day()
            logged_in = self._client is not None
            user_id = str(getattr(self._client, "user_id", "") or "") if self._client is not None else ""
            username = self._username or str(meta.get("username") or "")
        return {
            "ok": True,
            "loggedIn": logged_in,
            "needsLogin": not logged_in,
            "username": username or None,
            "userId": user_id or None,
            "session": self._session_note if logged_in else str(meta.get("session") or "none"),
            "lastLoginAt": meta.get("at"),
            "sentToday": state["sent"],
            "postToday": state["post"],
            "sendPerDay": self.send_per_day,
            "postPerDay": self.post_per_day,
            "pollSeconds": self.poll_seconds,
            "lastPollAt": self._cache.get("fetchedAt"),
            "hint": "" if logged_in else "跑 python src/ig_bridge.py --login 登入；如果未啟動 sidecar，DSH 會一直見到 IG_SIDECAR_DOWN",
        }


# --------------------------------------------------------------------------- http
class Handler(BaseHTTPRequestHandler):
    server_version = "ig-bridge/0.3"
    protocol_version = "HTTP/1.1"

    # Quiet the default per-request stderr line: bodies never reach the log.
    def log_message(self, fmt, *args):  # noqa: A003 - stdlib signature
        log.debug("%s - %s", self.address_string(), fmt % args)

    # ---- helpers ----------------------------------------------------------
    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.send_header("cache-control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except OSError as error:
            # The caller hung up (a Node timeout, a closing terminal). The work
            # already happened; a dropped socket must not become a traceback.
            log.debug("回應送不出去（%s）", error)

    def _authorised(self) -> bool:
        token = self.server.token
        if not token:
            return True
        provided = self.headers.get("x-ig-life-token") or ""
        return hmac.compare_digest(str(provided), str(token))

    def _read_body(self) -> dict:
        try:
            length = int(self.headers.get("content-length") or 0)
        except ValueError:
            raise BridgeError("IG_BAD_BODY", "content-length 不是數字", "", 400)
        if length > MAX_BODY_BYTES:
            raise BridgeError("IG_BODY_TOO_LARGE", f"body 超過 {MAX_BODY_BYTES} bytes", "相片要用 /post 傳路徑，不要塞進 JSON", 413)
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise BridgeError("IG_BAD_JSON", "body 不是合法 JSON", "", 400)
        if not isinstance(payload, dict):
            raise BridgeError("IG_BAD_JSON", "body 必須是 JSON object", "", 400)
        return payload

    def _dispatch(self, method: str) -> None:
        try:
            if not self._authorised():
                raise BridgeError(
                    "IG_SIDECAR_TOKEN_INVALID",
                    "sidecar token 不正確",
                    "兩邊要讀同一個 <dataDir>/sidecar-token；或者跑 python src/ig_bridge.py --print-token 看實際值",
                    401,
                )
            route = self.path.split("?", 1)[0].rstrip("/") or "/"
            bridge: Bridge = self.server.bridge
            if method == "GET" and route == "/health":
                self._send_json(200, bridge.health())
                return
            if method == "GET" and route == "/messages":
                self._send_json(200, bridge.poll())
                return
            if method == "GET" and route == "/credentials":
                self._send_json(200, bridge.credentials_payload())
                return
            if method == "POST" and route == "/credentials":
                self._send_json(200, bridge.save_credentials(self._read_body()))
                return
            if method == "POST" and route == "/login":
                self._send_json(200, bridge.login())
                return
            if method == "POST" and route == "/send":
                self._send_json(200, bridge.send(self._read_body()))
                return
            if method == "POST" and route == "/send_media":
                self._send_json(200, bridge.send_media(self._read_body()))
                return
            if method == "POST" and route == "/post":
                self._send_json(200, bridge.post(self._read_body()))
                return
            if method == "POST" and route == "/reply_comment":
                self._send_json(200, bridge.reply_comment(self._read_body()))
                return
            raise BridgeError("IG_NOT_FOUND", f"沒有這個 route：{method} {route}", "GET /health /messages /credentials；POST /send /send_media /post /reply_comment /credentials /login", 404)
        except BridgeError as error:
            log.warning("%s %s → %s %s", method, self.path, error.code, error.message)
            self._send_json(error.status, error.payload())
        except Exception as error:  # never leak a traceback over HTTP
            log.exception("未預期的錯誤")
            self._send_json(500, {"ok": False, "code": "IG_SIDECAR_ERROR", "error": str(error), "hint": "看 sidecar 的終端輸出"})

    # ---- verbs ------------------------------------------------------------
    def do_GET(self):  # noqa: N802 - stdlib naming
        self._dispatch("GET")

    def do_POST(self):  # noqa: N802
        self._dispatch("POST")


# ---------------------------------------------------------------------------- cli
def setup_logging(verbose: bool, data_dir: Path | None) -> None:
    root = logging.getLogger()
    root.setLevel(logging.DEBUG if verbose else logging.INFO)
    root.handlers.clear()
    formatter = logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%Y-%m-%d %H:%M:%S")
    stream = logging.StreamHandler(stream=sys.stderr)
    stream.setFormatter(formatter)
    stream.setLevel(logging.DEBUG if verbose else logging.INFO)
    root.addHandler(stream)
    if data_dir is not None:
        try:
            data_dir.mkdir(parents=True, exist_ok=True)
            handler = logging.FileHandler(data_dir / "ig-bridge.log", encoding="utf-8")
            handler.setFormatter(formatter)
            handler.setLevel(logging.DEBUG if verbose else logging.INFO)
            root.addHandler(handler)
        except OSError:
            pass


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ig_bridge.py",
        description="Local sidecar for dsh-ig-life's unofficial transport (a personal IG account).",
        epilog="⚠️ 非官方私有 API：違反 IG 條款，可能封號。用可以犧牲嘅小號。",
    )
    parser.add_argument("--serve", action="store_true", help="開始服務（其實是預設動作，這個 flag 只為講清楚）")
    parser.add_argument("--set-credentials", action="store_true", help="互動輸入 IG 帳號密碼（不會回顯），寫入 <dataDir>/ig-secrets.json")
    parser.add_argument("--login", action="store_true", help="登入一次（會先重用 session 檔），然後結束")
    parser.add_argument("--relogin", action="store_true", help="強制用密碼重新登入（最大封號風險）")
    parser.add_argument("--health", action="store_true", help="印出目前 session／額度狀態")
    parser.add_argument("--print-token", action="store_true", help="印出 sidecar token（給 unofficial.token 用）")
    parser.add_argument("--host", default=DEFAULT_HOST, help=f"綁定位址，預設 {DEFAULT_HOST}")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"port，預設 {DEFAULT_PORT}")
    parser.add_argument("--data-dir", default="", help="資料夾（預設 $DSH_HOME/ig-life，與插件一致）")
    parser.add_argument("--poll-seconds", type=int, default=20, help=f"兩次 /messages 之間最少幾秒（不會低於 {MIN_POLL_SECONDS}）")
    parser.add_argument("--send-per-day", type=int, default=30, help="每日訊息上限（sidecar 自己再擋一次）")
    parser.add_argument("--post-per-day", type=int, default=2, help="每日發帖上限")
    parser.add_argument("--media-root", action="append", default=[], help="額外允許上傳的資料夾（可重複）")
    parser.add_argument("--token", default="", help="覆寫 sidecar token（預設讀 <dataDir>/sidecar-token）")
    parser.add_argument("--verbose", action="store_true", help="debug log")
    return parser


def set_credentials(data_dir: Path) -> int:
    """
    Prompt for the account once and store it 0600.

    Hand-editing ig-secrets.json is the usual way to get this wrong: quoting,
    a BOM from an old PowerShell, the password ending up in shell history. The
    password is typed here, never echoed, never logged, never sent anywhere.
    """
    import getpass

    if not sys.stdin.isatty():
        print("要喺終端機直接執行才可以互動輸入密碼（--set-credentials）", file=sys.stderr)
        return 2
    print("⚠️ 用一個可以犧牲的小號。密碼只會寫入本機，不會出現在任何 log 或對話。")
    try:
        username = input("IG username（小號，不用 @）: ").strip().lstrip("@")
        if not username:
            print("username 不能空白，沒有寫入", file=sys.stderr)
            return 2
        password = getpass.getpass("IG password（輸入時不會顯示）: ")
        if not password:
            print("password 不能空白，沒有寫入", file=sys.stderr)
            return 2
        again = getpass.getpass("再輸入一次（確認沒有打錯）: ")
    except (EOFError, KeyboardInterrupt):
        print("\n取消，沒有寫入", file=sys.stderr)
        return 2
    if again != password:
        print("兩次不一樣，沒有寫入（舊檔案未改動）", file=sys.stderr)
        return 2

    target = data_dir / "ig-secrets.json"
    secure_write(target, json.dumps({"username": username, "password": password}, ensure_ascii=False, indent=2) + "\n")
    print(f"已寫入 {target}（權限 0600）。")
    print("下一步：python src/ig_bridge.py --login")
    return 0


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    data_dir = resolve_data_dir(args.data_dir)
    setup_logging(args.verbose, data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    token = load_or_create_token(data_dir, args.token)

    if args.print_token:
        print(token)
        return 0

    if args.set_credentials:
        return set_credentials(data_dir)

    media_roots = [data_dir] + list(args.media_root or [])
    bridge = Bridge(
        data_dir,
        poll_seconds=args.poll_seconds,
        send_per_day=args.send_per_day,
        post_per_day=args.post_per_day,
        media_roots=media_roots,
    )

    if args.health:
        try:
            bridge.ensure_client()
        except BridgeError as error:
            print(json.dumps({**error.payload(), "dataDir": str(data_dir)}, ensure_ascii=False, indent=2))
            return 2
        print(json.dumps(bridge.health(), ensure_ascii=False, indent=2))
        return 0

    if args.login or args.relogin:
        try:
            bridge.ensure_client(force_relogin=bool(args.relogin))
        except BridgeError as error:
            print(json.dumps(error.payload(), ensure_ascii=False, indent=2))
            return 2
        print(json.dumps(bridge.health(), ensure_ascii=False, indent=2))
        return 0

    if args.host not in ("127.0.0.1", "localhost", "::1"):
        log.warning("綁定在 %s —— sidecar 拿著登入憑證，正常只應該監聽 127.0.0.1", args.host)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    server.bridge = bridge
    server.token = token
    log.info("ig-bridge 監聽 http://%s:%s（資料夾 %s）", args.host, args.port, data_dir)
    log.warning("非官方私有 API：違反 IG 條款，有封號風險。確定用可以犧牲嘅小號。")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("收到 Ctrl+C，收工")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
