"""Secretary bot test suite. Stdlib only: python3 -m unittest discover -s tests."""
import json
import os
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import secretary_bot as sb

NOW = int(time.time())


class FakeCompleted:
    returncode = 0
    stdout = "Hi! Alex will get back to you shortly."
    stderr = ""


def make_msg(chat=777, sender=777, name="Sam", text="Hello?", ts=None,
             ctype="private", conn="conn-1", mid=5):
    m = {"message_id": mid, "date": NOW - 600 if ts is None else ts,
         "chat": {"id": chat, "type": ctype},
         "from": {"id": sender, "first_name": name},
         "business_connection_id": conn}
    if text is not None:
        m["text"] = text
    else:
        m["sticker"] = {"file_id": "x"}
    return m


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.sent = []
        self.pi_cmds = []
        self._real_run = sb.subprocess.run
        self._real_api = sb.api_call

        def fake_run(cmd, **kw):
            self.pi_cmds.append(cmd)
            return FakeCompleted()

        def fake_api(cfg, method, params=None, timeout=70):
            if method == "sendMessage":
                self.sent.append(params)
                return {"ok": True, "result": {"message_id": 1}}
            raise AssertionError("unexpected API call: " + method)

        sb.subprocess.run = fake_run
        sb.api_call = fake_api

        self.cfg = sb.Config.__new__(sb.Config)
        self.cfg.token = "test"
        self.cfg.pi_bin = "pi"
        self.cfg.pi_provider = ""
        self.cfg.pi_model = ""
        self.cfg.pi_thinking = "low"
        self.cfg.pi_timeout = 30
        self.cfg.owner_active_minutes = 0
        self.cfg.reply_delay_seconds = 0
        self.cfg.poll_timeout = 5
        self.cfg.data_dir = self.tmp
        self.cfg.owner_name = "Alex"
        self.cfg.system_prompt_file = os.path.join(
            os.path.dirname(__file__), "..", "SYSTEM.md")

    def tearDown(self):
        sb.subprocess.run = self._real_run
        sb.api_call = self._real_api

    def state(self, owner=111, last_owner=0):
        return {"owner_id": owner, "chats": {"777": {"last_owner_ts": last_owner}},
                "pending": {}}

    def history(self, slug="tg-777"):
        p = os.path.join(self.tmp, "chats", slug, "history.jsonl")
        if not os.path.exists(p):
            return []
        return [json.loads(l) for l in open(p)]

    def skips(self):
        out = []
        for l in open(os.path.join(self.tmp, "events.jsonl")):
            e = json.loads(l)
            if "skipped" in e:
                out.append(e["skipped"])
        return out


class TestReplyPath(Base):
    def test_stranger_gets_reply_with_connection_id(self):
        st = self.state(last_owner=NOW - 3600)
        reply = sb.handle_business_message(
            self.cfg, st, make_msg(ts=NOW - 60), "sys")
        self.assertEqual(reply, FakeCompleted.stdout)
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.sent[0]["business_connection_id"], "conn-1")
        self.assertEqual(self.sent[0]["chat_id"], "777")

    def test_pi_called_ephemeral_without_tools(self):
        st = self.state(last_owner=NOW - 3600)
        sb.handle_business_message(self.cfg, st, make_msg(ts=NOW - 60), "sys")
        cmd = self.pi_cmds[0]
        for flag in ["-p", "--no-tools", "--no-extensions",
                     "--no-skills", "-nc", "--no-session"]:
            self.assertIn(flag, cmd)
        self.assertNotIn("--session", cmd)

    def test_prompt_carries_transcript_with_roles(self):
        st = self.state(last_owner=NOW - 3600)
        sb.handle_business_message(
            self.cfg, st, make_msg(sender=111, name="Alex",
                                   text="I'm in Antalya"), "")
        sb.handle_business_message(
            self.cfg, st, make_msg(ts=NOW - 60, text="Where?"), "")
        prompt = self.pi_cmds[0][-1]
        self.assertIn("OWNER: Alex: I'm in Antalya", prompt)
        self.assertIn("VISITOR: Sam: Where?", prompt)

    def test_history_records_all_three_actors(self):
        st = self.state(last_owner=NOW - 3600)
        sb.handle_business_message(
            self.cfg, st, make_msg(sender=111, name="Alex", text="one sec"), "")
        sb.handle_business_message(
            self.cfg, st, make_msg(ts=NOW - 60, text="ok?"), "")
        roles = [m["role"] for m in self.history()]
        self.assertEqual(roles, ["OWNER", "VISITOR", "SECRETARY"])


class TestQuietRules(Base):
    def test_own_message_never_answered(self):
        st = self.state()
        self.assertIsNone(sb.handle_business_message(
            self.cfg, st, make_msg(sender=111, name="Alex", text="hey"), ""))
        self.assertEqual(self.pi_cmds, [])
        self.assertIn("own message", self.skips())

    def test_owner_learned_from_private_chat_shape(self):
        st = {"owner_id": 0, "chats": {}}
        self.assertIsNone(sb.handle_business_message(
            self.cfg, st, make_msg(sender=111, name="Alex", text="hi"), ""))
        self.assertEqual(st["owner_id"], 111)
        self.assertEqual(self.pi_cmds, [])

    def test_stranger_matching_chat_id_is_not_owner(self):
        st = {"owner_id": 0, "chats": {}}
        sb.handle_business_message(
            self.cfg, st, make_msg(chat=777, sender=777, ts=NOW - 60), "")
        self.assertEqual(len(self.pi_cmds), 1)

    def test_owner_replied_already_stays_quiet(self):
        st = self.state(last_owner=NOW - 5 * 60)
        self.assertIsNone(sb.handle_business_message(
            self.cfg, st, make_msg(ts=NOW - 6 * 60), ""))
        self.assertEqual(self.pi_cmds, [])
        self.assertIn("owner replied already", self.skips())

    def test_active_window_off_by_default(self):
        st = self.state(last_owner=NOW - 120)
        sb.handle_business_message(
            self.cfg, st, make_msg(ts=NOW - 60), "")
        self.assertEqual(len(self.pi_cmds), 1)

    def test_active_window_on_silences(self):
        self.cfg.owner_active_minutes = 10
        st = self.state(last_owner=NOW - 120)
        self.assertIsNone(sb.handle_business_message(
            self.cfg, st, make_msg(ts=NOW - 60), ""))
        self.assertEqual(self.pi_cmds, [])
        self.assertIn("owner active", self.skips())

    def test_non_text_skipped_but_recorded(self):
        st = self.state(last_owner=NOW - 3600)
        self.assertIsNone(sb.handle_business_message(
            self.cfg, st, make_msg(ts=NOW - 60, text=None), ""))
        self.assertEqual(self.pi_cmds, [])
        self.assertTrue(
            self.history()[-1]["text"].endswith("[non-text message]"))


class TestHistoryHelpers(Base):
    def test_load_tail_bounds_messages_and_chars(self):
        for i in range(50):
            sb.append_history(self.tmp, "tg-777", "VISITOR", "x" * 100, NOW)
        tail = sb.load_tail(self.tmp, "tg-777")
        self.assertLessEqual(len(tail), 40)
        tail2 = sb.load_tail(self.tmp, "tg-777", max_chars=250)
        self.assertTrue(sum(len(m["text"]) for m in tail2) <= 350)

    def test_load_tail_missing_file(self):
        self.assertEqual(sb.load_tail(self.tmp, "tg-nobody"), [])

    def test_load_tail_skips_corrupt_lines(self):
        p = sb.history_path(self.tmp, "tg-777")
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f:
            f.write("not json\n")
            f.write(json.dumps({"ts": 1, "role": "VISITOR",
                                "text": "hi"}) + "\n")
        self.assertEqual(len(sb.load_tail(self.tmp, "tg-777")), 1)

    def test_format_transcript(self):
        self.assertEqual(
            sb.format_transcript([{"role": "OWNER", "text": "yo"}]),
            "OWNER: yo")

    def test_state_roundtrip_and_corrupt(self):
        sb.save_state(self.tmp, {"owner_id": 5, "chats": {}})
        self.assertEqual(sb.load_state(self.tmp)["owner_id"], 5)
        with open(os.path.join(self.tmp, "state.json"), "w") as f:
            f.write("broken{")
        self.assertEqual(sb.load_state(self.tmp),
                         {"owner_id": 0, "chats": {}, "pending": {}})

    def test_system_prompt_names_owner_and_actors(self):
        sp = sb.build_system_prompt(self.cfg)
        self.assertIn("Alex", sp)
        self.assertNotIn("{OWNER}", sp)
        for actor in ["OWNER", "VISITOR", "SECRETARY"]:
            self.assertIn(actor, sp)

class TestReplyDelay(Base):
    def test_visitor_schedules_not_sends(self):
        self.cfg.reply_delay_seconds = 120
        st = self.state(last_owner=NOW - 3600)
        self.assertIsNone(sb.handle_business_message(
            self.cfg, st, make_msg(ts=NOW - 60), "sys", now=NOW))
        self.assertEqual(self.pi_cmds, [])
        self.assertEqual(self.sent, [])
        self.assertIn("777", st["pending"])
        # history recorded even though nothing sent
        self.assertEqual([m["role"] for m in self.history()], ["VISITOR"])

    def test_due_reply_sends_after_wait(self):
        self.cfg.reply_delay_seconds = 120
        st = self.state(last_owner=NOW - 3600)
        sb.handle_business_message(
            self.cfg, st, make_msg(ts=NOW - 60), "sys", now=NOW)
        self.assertEqual(sb.process_due_replies(self.cfg, st, "sys", now=NOW + 60), 0)
        self.assertEqual(self.sent, [])
        self.assertEqual(sb.process_due_replies(self.cfg, st, "sys", now=NOW + 121), 1)
        self.assertEqual(len(self.sent), 1)
        self.assertEqual([m["role"] for m in self.history()],
                         ["VISITOR", "SECRETARY"])

    def test_owner_message_cancels_pending(self):
        self.cfg.reply_delay_seconds = 120
        st = self.state(last_owner=NOW - 3600)
        sb.handle_business_message(
            self.cfg, st, make_msg(ts=NOW - 60), "sys", now=NOW)
        self.assertIn("777", st["pending"])
        sb.handle_business_message(
            self.cfg, st,
            make_msg(sender=111, name="Alex", text="I got this", ts=NOW + 10),
            "sys", now=NOW + 10)
        self.assertNotIn("777", st.get("pending", {}))
        self.assertEqual(sb.process_due_replies(self.cfg, st, "sys", now=NOW + 200), 0)
        self.assertEqual(self.sent, [])
        self.assertEqual(self.pi_cmds, [])
        # both turns kept in history even though bot stayed silent
        self.assertEqual([m["role"] for m in self.history()],
                         ["VISITOR", "OWNER"])

    def test_burst_debounced_to_single_reply(self):
        self.cfg.reply_delay_seconds = 120
        st = self.state(last_owner=NOW - 3600)
        sb.handle_business_message(
            self.cfg, st, make_msg(ts=NOW, text="one", mid=1), "sys", now=NOW)
        sb.handle_business_message(
            self.cfg, st, make_msg(ts=NOW + 30, text="two", mid=2), "sys",
            now=NOW + 30)
        self.assertEqual(len(st["pending"]), 1)
        self.assertEqual(sb.process_due_replies(self.cfg, st, "sys", now=NOW + 121), 0)
        self.assertEqual(sb.process_due_replies(self.cfg, st, "sys", now=NOW + 151), 1)
        self.assertEqual(len(self.sent), 1)
        prompt = self.pi_cmds[0][-1]
        self.assertIn("one", prompt)
        self.assertIn("two", prompt)

    def test_skipped_messages_still_recorded(self):
        self.cfg.reply_delay_seconds = 120
        self.cfg.owner_active_minutes = 10
        st = self.state(last_owner=NOW - 120)
        self.assertIsNone(sb.handle_business_message(
            self.cfg, st, make_msg(ts=NOW - 60), "sys", now=NOW))
        self.assertEqual(self.pi_cmds, [])
        self.assertEqual([m["role"] for m in self.history()], ["VISITOR"])


class TestRunLoop(Base):
    def test_dispatch_connection_message_edited_deleted(self):
        batches = [
            {"ok": True, "result": [
                {"update_id": 1, "business_connection": {
                    "id": "c1", "user_id": 111, "date": NOW}},
                {"update_id": 2, "business_message": make_msg(
                    ts=NOW - 60, mid=10)},
                {"update_id": 3, "edited_business_message": make_msg(
                    ts=NOW - 30, text="Hello!!", mid=10)},
                {"update_id": 4, "deleted_business_messages": {
                    "chat": {"id": 777}, "messages": [9]}},
            ]},
            KeyboardInterrupt,
        ]

        def fake_poll(cfg, method, params=None, timeout=70):
            if method == "sendMessage":
                self.sent.append(params)
                return {"ok": True, "result": {"message_id": 1}}
            nxt = batches.pop(0)
            if nxt is KeyboardInterrupt:
                raise KeyboardInterrupt
            return nxt

        sb.api_call = fake_poll
        # drive run() until it exhausts batches, then stop it
        calls = {"n": 0}
        orig_handler = sb.handle_business_message

        def counting_handler(cfg, state, msg, sp):
            calls["n"] += 1
            return orig_handler(cfg, state, msg, sp)

        sb.handle_business_message = counting_handler
        try:
            sb.run(self.cfg)
        except KeyboardInterrupt:
            pass
        finally:
            sb.handle_business_message = orig_handler
        self.assertEqual(calls["n"], 2)  # message + edited
        types = [json.loads(l)["type"]
                 for l in open(os.path.join(self.tmp, "events.jsonl"))]
        self.assertIn("connection", types)
        self.assertIn("deleted", types)
        st = sb.load_state(self.tmp)
        self.assertEqual(st["owner_id"], 111)


if __name__ == "__main__":
    unittest.main()
