#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Tests for the sidecar — stdlib only, no instagrapi, no network.

The risky part of the unofficial transport is this process: it holds the
session and it decides how fast Instagram is touched. These tests exercise the
logic that can be tested honestly — message normalisation, the daily ceiling,
the media-root guard, token auth, and the HTTP contract the Node transport
speaks — with a fake client standing in for instagrapi.

    python src/test_ig_bridge.py
"""

from __future__ import annotations

import http.client
import importlib.util
import json
import os
import tempfile
import threading
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

MODULE_PATH = Path(__file__).with_name("ig_bridge.py")
SPEC = importlib.util.spec_from_file_location("ig_bridge", MODULE_PATH)
igb = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(igb)

TOKEN = "test-token"


# --------------------------------------------------------------------------- fixtures
class FakeClient:
    """What instagrapi would return, shaped like the parts we actually read."""

    user_id = 99
    username = "me"

    @staticmethod
    def _at(minutes_ago=0):
        from datetime import timedelta

        return datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)

    def direct_threads(self, amount=8):
        return [
            SimpleNamespace(
                id="t1",
                is_group=False,
                last_activity_at=self._at(1),
                users=[SimpleNamespace(pk=7, username="alice"), SimpleNamespace(pk=99, username="me")],
            )
        ]

    def direct_messages(self, thread_id, amount=15):
        return [
            SimpleNamespace(id="m1", user_id=7, item_type="text", text="你好", timestamp=self._at(3)),
            SimpleNamespace(id="m2", user_id=99, item_type="text", text="我自己講嘅", timestamp=self._at(2)),
            SimpleNamespace(
                id="m3",
                user_id=7,
                item_type="media",
                text="",
                timestamp=self._at(1),
                media={"id": "media-1", "media_type": 1, "image_versions2": {"candidates": [{"url": "https://cdn.example/x.jpg"}]}},
            ),
        ]

    def direct_send(self, text, **target):
        self.last_send = (text, target)
        return [SimpleNamespace(id="sent-1")]

    def direct_send_photo(self, path, **target):
        self.last_media = (path, target)
        return [SimpleNamespace(id="photo-1")]

    def photo_upload(self, path, caption):
        return SimpleNamespace(pk="999", code="ABC123")

    def media_comment(self, media_id, text, replied_to_comment_id=None):
        return SimpleNamespace(pk="comment-1")


# ---------------------------------------------------------------------- normalising
class NormaliseTest(unittest.TestCase):
    def test_text_message(self):
        message = SimpleNamespace(
            id="m1", user_id=7, item_type="text", text="你好", timestamp=datetime(2026, 11, 3, 4, 0, tzinfo=timezone.utc)
        )
        item = igb.normalise_message(message, "t1", {7: "alice"}, 99)
        self.assertEqual(item["id"], "m1")
        self.assertEqual(item["threadId"], "t1")
        self.assertEqual(item["username"], "alice")
        self.assertEqual(item["text"], "你好")
        self.assertEqual(item["at"], "2026-11-03T04:00:00Z")
        self.assertEqual(item["attachments"], [])

    def test_own_message_is_dropped(self):
        message = SimpleNamespace(id="m2", user_id=99, item_type="text", text="我", timestamp=None)
        self.assertIsNone(igb.normalise_message(message, "t1", {}, 99))

    def test_like_and_action_log_are_dropped(self):
        for kind in ("like", "action_log", "placeholder", "reaction_log"):
            message = SimpleNamespace(id="x", user_id=7, item_type=kind, text="", timestamp=None)
            self.assertIsNone(igb.normalise_message(message, "t1", {7: "alice"}, 99), kind)

    def test_photo_becomes_an_image_attachment(self):
        message = SimpleNamespace(
            id="m3",
            user_id=7,
            item_type="media",
            text="",
            timestamp=None,
            media={"id": "media-1", "media_type": 1, "image_versions2": {"candidates": [{"url": "https://cdn.example/x.jpg"}]}},
        )
        item = igb.normalise_message(message, "t1", {7: "alice"}, 99)
        self.assertEqual(item["attachments"][0]["type"], "image")
        self.assertEqual(item["attachments"][0]["payload"]["url"], "https://cdn.example/x.jpg")

    def test_voice_note_becomes_audio(self):
        message = SimpleNamespace(
            id="m4",
            user_id=7,
            item_type="voice_media",
            text="",
            timestamp=None,
            voice_media={"audio": {"url": "https://cdn.example/v.m4a"}},
        )
        item = igb.normalise_message(message, "t1", {7: "alice"}, 99)
        self.assertEqual(item["attachments"][0]["type"], "audio")
        self.assertEqual(item["attachments"][0]["payload"]["url"], "https://cdn.example/v.m4a")

    def test_shared_reel_becomes_a_share_with_a_permalink(self):
        message = SimpleNamespace(
            id="m5", user_id=7, item_type="reel_share", text="", timestamp=None, clip={"id": "555", "code": "Cxyz"}
        )
        item = igb.normalise_message(message, "t1", {7: "alice"}, 99)
        self.assertEqual(item["attachments"][0]["type"], "share")
        self.assertEqual(item["attachments"][0]["payload"]["url"], "https://www.instagram.com/p/Cxyz/")

    def test_unknown_attachment_is_reported_not_invented(self):
        message = SimpleNamespace(id="m6", user_id=7, item_type="some_new_thing", text="", timestamp=None)
        item = igb.normalise_message(message, "t1", {7: "alice"}, 99)
        self.assertEqual(item["attachments"][0]["type"], "some_new_thing")
        self.assertEqual(item["attachments"][0]["payload"], {})


# ---------------------------------------------------------------------------- http
class SidecarTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ig-bridge-test-")
        self.data_dir = Path(self.tmp.name)
        self.bridge = igb.Bridge(self.data_dir, poll_seconds=10, send_per_day=5, post_per_day=2)
        self.fake = FakeClient()
        self.bridge._client = self.fake
        self.bridge._username = "me"
        self.bridge._session_note = "reused"

        self.server = igb.ThreadingHTTPServer(("127.0.0.1", 0), igb.Handler)
        self.server.daemon_threads = True
        self.server.bridge = self.bridge
        self.server.token = TOKEN
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def request(self, method, path, body=None, token=TOKEN):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        headers = {}
        if token:
            headers["x-ig-life-token"] = token
        payload = None
        if body is not None:
            payload = json.dumps(body).encode("utf-8")
            headers["content-type"] = "application/json"
        connection.request(method, path, body=payload, headers=headers)
        response = connection.getresponse()
        raw = response.read()
        connection.close()
        try:
            parsed = json.loads(raw.decode("utf-8")) if raw else {}
        except ValueError:
            parsed = {"raw": raw.decode("utf-8", "replace")}
        return response.status, parsed

    # ---- auth
    def test_missing_token_is_refused(self):
        status, payload = self.request("GET", "/health", token=None)
        self.assertEqual(status, 401)
        self.assertEqual(payload["code"], "IG_SIDECAR_TOKEN_INVALID")

    def test_wrong_token_is_refused(self):
        status, _ = self.request("GET", "/health", token="nope")
        self.assertEqual(status, 401)

    # ---- health
    def test_health_reports_the_session_without_logging_in(self):
        status, payload = self.request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertTrue(payload["loggedIn"])
        self.assertFalse(payload["needsLogin"])
        self.assertEqual(payload["session"], "reused")
        self.assertEqual(payload["sendPerDay"], 5)

    # ---- credentials
    def test_credentials_are_stored_but_never_returned(self):
        status, payload = self.request("GET", "/credentials")
        self.assertEqual(status, 200)
        self.assertFalse(payload["hasCredentials"])

        status, payload = self.request("POST", "/credentials", {"username": "@tester", "password": "s3cret"})
        self.assertEqual(status, 200)
        self.assertEqual(payload["username"], "tester")
        self.assertNotIn("s3cret", json.dumps(payload), "the password must never cross the wire")

        stored = json.loads((self.data_dir / "ig-secrets.json").read_text(encoding="utf-8-sig"))
        self.assertEqual(stored, {"username": "tester", "password": "s3cret"})
        if os.name != "nt":
            self.assertEqual((self.data_dir / "ig-secrets.json").stat().st_mode & 0o777, 0o600)

        status, payload = self.request("GET", "/credentials")
        self.assertTrue(payload["hasCredentials"])
        self.assertEqual(payload["username"], "tester")
        self.assertNotIn("s3cret", json.dumps(payload))

    def test_a_blank_password_keeps_the_stored_one(self):
        self.request("POST", "/credentials", {"username": "tester", "password": "first"})
        status, _ = self.request("POST", "/credentials", {"username": "tester", "password": ""})
        self.assertEqual(status, 200)
        stored = json.loads((self.data_dir / "ig-secrets.json").read_text(encoding="utf-8-sig"))
        self.assertEqual(stored["password"], "first")

    def test_a_first_save_without_a_password_is_refused(self):
        status, payload = self.request("POST", "/credentials", {"username": "tester"})
        self.assertEqual(status, 400)
        self.assertEqual(payload["code"], "IG_NO_CREDENTIALS")

    def test_login_reports_an_already_connected_client(self):
        status, payload = self.request("POST", "/login")
        self.assertEqual(status, 200)
        self.assertTrue(payload["loggedIn"])
        self.assertFalse(payload["needsLogin"])

    # ---- inbound
    def test_messages_drops_our_own_and_keeps_the_rest(self):
        status, payload = self.request("GET", "/messages")
        self.assertEqual(status, 200)
        ids = [item["id"] for item in payload["messages"]]
        self.assertEqual(ids, ["m1", "m3"], "our own message must never be ingested")
        self.assertFalse(payload["throttled"])

    def test_second_poll_inside_the_window_is_throttled(self):
        self.request("GET", "/messages")
        status, payload = self.request("GET", "/messages")
        self.assertEqual(status, 200)
        self.assertTrue(payload["throttled"])
        self.assertEqual(payload["messages"], [], "a throttle must not replay the cache")

    def test_ids_are_not_delivered_twice_after_the_window(self):
        self.request("GET", "/messages")
        self.bridge._last_poll_at = 0.0  # pretend the poll window elapsed
        status, payload = self.request("GET", "/messages")
        self.assertEqual(status, 200)
        self.assertEqual(payload["messages"], [], "seen ids must survive a forced re-poll")

    def test_an_unknown_sender_gets_a_username_lookup(self):
        class UnknownSender(FakeClient):
            def direct_threads(self, amount=8):
                return [SimpleNamespace(id="t2", is_group=False, last_activity_at=self._at(1), users=[])]

            def direct_messages(self, thread_id, amount=15):
                return [SimpleNamespace(id="u1", user_id=8, item_type="text", text="hello", timestamp=self._at(2))]

            def user_info(self, user_id):
                self.looked_up = user_id
                return SimpleNamespace(username="bob")

        client = UnknownSender()
        self.bridge._client = client
        status, payload = self.request("GET", "/messages")
        self.assertEqual(status, 200)
        self.assertEqual(payload["messages"][0]["username"], "bob", "without a username the allowlist cannot match")
        self.assertEqual(client.looked_up, 8)
        self.assertEqual(self.bridge._usernames.get(8), "bob", "the lookup is cached for later polls")

    def test_the_first_sight_of_a_thread_is_capped(self):
        class BusyThread(FakeClient):
            def direct_messages(self, thread_id, amount=15):
                return [
                    SimpleNamespace(id=f"b{index}", user_id=7, item_type="text", text=f"msg{index}", timestamp=self._at(10 - index))
                    for index in range(6)
                ]

        self.bridge._client = BusyThread()
        status, payload = self.request("GET", "/messages")
        self.assertEqual(status, 200)
        ids = [item["id"] for item in payload["messages"]]
        self.assertEqual(ids, ["b3", "b4", "b5"], "only the newest few on first contact, never the whole history")

    # ---- outbound
    def test_send_records_and_returns_an_id(self):
        status, payload = self.request("POST", "/send", {"text": "喂", "threadId": "t1"})
        self.assertEqual(status, 200)
        self.assertEqual(payload["id"], "sent-1")
        self.assertEqual(self.fake.last_send[0], "喂")
        self.assertEqual(self.fake.last_send[1], {"thread_ids": ["t1"]})

    def test_send_targets_a_username_when_there_is_no_thread(self):
        self.request("POST", "/send", {"text": "hi", "username": "@alice"})
        self.assertEqual(self.fake.last_send[1], {"usernames": ["alice"]})

    def test_empty_send_is_refused(self):
        status, payload = self.request("POST", "/send", {"text": "   ", "threadId": "t1"})
        self.assertEqual(status, 400)
        self.assertEqual(payload["code"], "IG_EMPTY_MESSAGE")

    def test_daily_cap_is_enforced_in_the_sidecar_too(self):
        self.bridge.send_per_day = 0
        status, payload = self.request("POST", "/send", {"text": "hi", "threadId": "t1"})
        self.assertEqual(status, 429)
        self.assertEqual(payload["code"], "IG_DAILY_CAP")

    def test_send_without_a_recipient_is_refused(self):
        status, payload = self.request("POST", "/send", {"text": "hi"})
        self.assertEqual(status, 400)
        self.assertEqual(payload["code"], "IG_NO_RECIPIENT")

    # ---- media
    def _image(self, directory: Path) -> Path:
        file = directory / "photo.png"
        file.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 32)
        return file

    def test_send_media_inside_the_data_dir_works(self):
        file = self._image(self.data_dir)
        status, payload = self.request("POST", "/send_media", {"path": str(file), "type": "image", "threadId": "t1"})
        self.assertEqual(status, 200)
        self.assertEqual(payload["id"], "photo-1")
        self.assertEqual(payload["mode"], "image")

    def test_send_media_outside_the_allowed_roots_is_refused(self):
        outside = self._image(Path(tempfile.gettempdir()))
        try:
            status, payload = self.request("POST", "/send_media", {"path": str(outside), "type": "image", "threadId": "t1"})
            self.assertEqual(status, 403)
            self.assertEqual(payload["code"], "IG_MEDIA_ROOT")
        finally:
            outside.unlink(missing_ok=True)

    def test_send_media_missing_file_is_refused(self):
        status, payload = self.request("POST", "/send_media", {"path": str(self.data_dir / "nope.png"), "type": "image", "threadId": "t1"})
        self.assertEqual(status, 404)
        self.assertEqual(payload["code"], "IG_MEDIA_NOT_FOUND")

    def test_post_returns_a_permalink(self):
        file = self._image(self.data_dir)
        status, payload = self.request("POST", "/post", {"caption": "今日", "imagePath": str(file)})
        self.assertEqual(status, 200)
        self.assertEqual(payload["mediaId"], "999")
        self.assertEqual(payload["permalink"], "https://www.instagram.com/p/ABC123/")

    def test_reply_comment_needs_a_media_id(self):
        status, payload = self.request("POST", "/reply_comment", {"commentId": "c1", "text": "hi"})
        self.assertEqual(status, 400)
        self.assertEqual(payload["code"], "IG_COMMENT_NEEDS_MEDIA")

    # ---- misc
    def test_unknown_route_is_a_404_with_a_code(self):
        status, payload = self.request("GET", "/nothing")
        self.assertEqual(status, 404)
        self.assertEqual(payload["code"], "IG_NOT_FOUND")

    def test_bad_json_is_a_400(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        connection.request(
            "POST",
            "/send",
            body=b"{not json",
            headers={"x-ig-life-token": TOKEN, "content-type": "application/json"},
        )
        response = connection.getresponse()
        raw = response.read()
        connection.close()
        self.assertEqual(response.status, 400)
        self.assertEqual(json.loads(raw.decode("utf-8"))["code"], "IG_BAD_JSON")

    def test_token_file_is_created_privately(self):
        token = igb.load_or_create_token(self.data_dir)
        self.assertEqual(len(token), 48)
        self.assertTrue((self.data_dir / "sidecar-token").exists())
        if os.name != "nt":
            mode = (self.data_dir / "sidecar-token").stat().st_mode & 0o777
            self.assertEqual(mode, 0o600)


# ---------------------------------------------------------------------------- caps
class LimitTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ig-bridge-cap-")
        self.bridge = igb.Bridge(Path(self.tmp.name), send_per_day=2, post_per_day=1)

    def tearDown(self):
        self.tmp.cleanup()

    def test_poll_seconds_can_never_go_below_ten(self):
        bridge = igb.Bridge(Path(self.tmp.name), poll_seconds=1)
        self.assertEqual(bridge.poll_seconds, 10)

    def test_message_cap(self):
        self.bridge.check_cap("dm")
        self.bridge.check_cap("dm")
        with self.assertRaises(igb.BridgeError) as caught:
            self.bridge.check_cap("dm")
        self.assertEqual(caught.exception.code, "IG_DAILY_CAP")

    def test_post_cap(self):
        self.bridge.check_cap("post")
        with self.assertRaises(igb.BridgeError):
            self.bridge.check_cap("post")

    def test_unknown_exception_is_mapped_with_a_hint(self):
        mapped = igb._map_exception(RuntimeError("boom"))
        self.assertEqual(mapped.code, "IG_UNOFFICIAL_ERROR")
        self.assertIn("instagrapi", mapped.hint)

    def test_known_exception_names_map_to_actionable_codes(self):
        class ChallengeRequired(Exception):
            pass

        mapped = igb._map_exception(ChallengeRequired("verify"))
        self.assertEqual(mapped.code, "IG_CHALLENGE_REQUIRED")
        self.assertEqual(mapped.status, 403)

    def test_a_bom_in_a_json_file_is_tolerated(self):
        # Windows PowerShell 5.1 writes UTF-8 with a BOM; json.loads rejects it.
        path = Path(self.tmp.name) / "ig-secrets.json"
        path.write_bytes(b'\xef\xbb\xbf{"username": "me", "password": "pw"}')
        loaded = igb.load_json(path, {})
        self.assertEqual(loaded["username"], "me")
        self.assertTrue(path.exists(), "a readable file must not be quarantined")


if __name__ == "__main__":
    unittest.main(verbosity=2)
