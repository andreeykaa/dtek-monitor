"""
Тести перевірки графіка (checker/check.py).
Запуск: python -m unittest discover -s tests -v

Сайт ДТЕК, Telegram і базу D1 замінено заглушками (D1 — SQLite у пам'яті),
час «заморожено», щоб перевіряти попередження за 30 хв.
"""

import json
import os
import re
import sqlite3
import sys
import unittest
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "checker"))
os.environ.update(CLOUDFLARE_API_TOKEN="x", CLOUDFLARE_ACCOUNT_ID="x", TELEGRAM_BOT_TOKEN="x", HEALTHCHECK_URL="")
import check  # noqa: E402

K = check.KYIV
DAY = datetime(2026, 11, 17, tzinfo=K)  # вівторок
SCHEMA = (ROOT / "worker" / "schema.sql").read_text(encoding="utf-8")

# сьогодні: світло до 13:00, 13–18 немає, 18–22 є, 22–24 немає
TODAY = ["yes"] * 13 + ["no"] * 5 + ["yes"] * 4 + ["no"] * 2


def plain(text):
    return re.sub(r"<[^>]+>", "", text).replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")


class FrozenDT(datetime):
    NOW = DAY

    @classmethod
    def now(cls, tz=None):
        return cls.NOW


class CheckerTest(unittest.TestCase):
    def setUp(self):
        self.con = sqlite3.connect(":memory:", check_same_thread=False)
        self.con.row_factory = sqlite3.Row
        self.con.executescript(SCHEMA)
        con = self.con

        class FakeD1:
            def q(self, sql, *p):
                cur = con.execute(sql, p)
                con.commit()
                return [dict(r) for r in cur.fetchall()] if cur.description else []

        self.sent = []
        self.fail_for = {}   # chat_id -> 'blocked' | 'error'
        self.today, self.tomorrow = TODAY, None
        self.houses = {"7": {"sub_type_reason": ["GPV33.1"]}}

        def fake_send(cid, text, keyboard=None, silent=False):
            self.sent.append({"cid": cid, "text": plain(text), "kb": keyboard, "silent": silent})
            return self.fail_for.get(cid, "ok")

        def fake_site(streets):
            ts0, ts1 = int(DAY.timestamp()), int((DAY + timedelta(days=1)).timestamp())
            data = {str(ts0): {"GPV33.1": {str(i + 1): v for i, v in enumerate(self.today)}}}
            if self.tomorrow:
                data[str(ts1)] = {"GPV33.1": {str(i + 1): v for i, v in enumerate(self.tomorrow)}}
            return {"fact": {"data": data, "update": "17.11.2026 10:00"},
                    "allStreets": ["просп. Голосіївський", "вул. Хрещатик"],
                    "houses": {s: {"data": self.houses} for s in streets}}

        self.patches = {"D1": check.D1, "tg_send": check.tg_send, "fetch_site": check.fetch_site,
                        "datetime": check.datetime, "log": check.log}
        check.D1, check.tg_send, check.fetch_site = FakeD1, fake_send, fake_site
        check.datetime, check.log = FrozenDT, (lambda m: None)
        self.patches["LIMITER"] = check.LIMITER
        check.LIMITER = check.RateLimiter(100_000)  # у тестах без ліміту Telegram

    def tearDown(self):
        for k, v in self.patches.items():
            setattr(check, k, v)
        self.con.close()

    # ---------------------------------------------------------------- helpers

    def add(self, cid, state="active", warn=0, days=None, house="7", warned=None):
        last = json.dumps({DAY.date().isoformat(): days or TODAY}) if state == "active" else None
        self.con.execute(
            "INSERT INTO users (chat_id, state, street, house, grp, last_days, warn, warned) VALUES (?,?,?,?,?,?,?,?)",
            (cid, state, "просп. Голосіївський", house, "GPV33.1" if state == "active" else None, last, warn, warned))
        self.con.commit()

    def run_at(self, h, m, s=30):
        FrozenDT.NOW = DAY + timedelta(hours=h, minutes=m, seconds=s)
        self.sent.clear()
        self.assertEqual(check.main(), 0)
        return self.sent

    def row(self, cid):
        return dict(self.con.execute("SELECT * FROM users WHERE chat_id = ?", (cid,)).fetchone())

    def texts(self, cid=None):
        return [m["text"] for m in self.sent if cid is None or m["cid"] == cid]

    # ---------------------------------------------------------------- адреси

    def test_confirm_address_and_offer(self):
        self.add(1, state="pending", warn=None)
        sent = self.run_at(9, 0)
        self.assertIn("Адресу підтверджено", sent[0]["text"])
        self.assertIn("група 33", sent[0]["text"])
        self.assertIn("Можу попереджати", sent[-1]["text"])
        self.assertEqual([r[0]["text"] for r in sent[-1]["kb"]["inline_keyboard"]],
                         ["⏰ Попереджати про світло", "Ні, дякую"])
        self.assertEqual(self.row(1)["state"], "active")
        self.assertEqual(self.row(1)["warn"], 0)
        # повторне підтвердження (зміна адреси) — без пропозиції
        self.con.execute("UPDATE users SET state = 'pending' WHERE chat_id = 1")
        self.con.commit()
        self.run_at(9, 10)
        self.assertIn("Адресу підтверджено", self.texts(1)[0])
        self.assertFalse(any("Можу попереджати" in t for t in self.texts()))

    def test_house_not_found(self):
        self.add(1, state="pending", house="99")
        self.run_at(9, 0)
        self.assertIn("не знайдено", self.texts(1)[0])
        self.assertEqual(self.row(1)["state"], "awaiting_house")

    def test_house_number_variants(self):
        self.houses = {"7-А": {"sub_type_reason": ["GPV33.1"]}}
        self.add(1, state="pending", house="7а")
        self.run_at(9, 0)
        self.assertEqual(self.row(1)["house"], "7-А")

    # ---------------------------------------------------------------- графік

    def test_no_changes_no_messages(self):
        self.add(1)
        self.assertEqual(self.run_at(9, 0), [])

    def test_schedule_change_and_tomorrow(self):
        self.add(1)
        self.today = ["yes"] * 14 + ["no"] * 4 + ["yes"] * 4 + ["no"] * 2
        self.run_at(9, 0)
        self.assertIn("Змінився графік на сьогодні", self.texts(1)[0])
        self.assertIn("Було:", self.texts(1)[0])
        self.tomorrow = ["yes"] * 24
        self.run_at(9, 10)
        self.assertIn("З'явився графік на завтра", self.texts(1)[0])
        self.assertEqual(self.run_at(9, 20), [])  # без дублів

    # ---------------------------------------------------------------- попередження

    def test_warnings_full_day(self):
        self.add(1, warn=1)
        self.add(2, warn=0)
        got = []
        for h in range(12, 24):
            for m in range(0, 60, 10):
                for msg in self.run_at(h, m):
                    self.assertEqual(msg["cid"], 1)  # користувач без попереджень нічого не отримує
                    got.append((f"{h:02d}:{m:02d}", msg["text"]))
        self.assertEqual([t for t, _ in got], ["12:30", "17:30", "21:30"])
        self.assertEqual(got[0][1], "🔴 13:00 — вимкнення світла за графіком\n"
                                    "Залишилось 30 хв · світла не буде до 18:00 (5 год)")
        self.assertEqual(got[1][1], "🟢 18:00 — увімкнення світла за графіком\n"
                                    "Залишилось 30 хв · світло буде до 22:00 (4 год)")
        self.assertIn("світла не буде до кінця доби", got[2][1])

    def test_missed_check_and_no_duplicates(self):
        self.add(1, warn=1)
        self.run_at(12, 40)
        self.assertIn("Залишилось 20 хв", self.texts(1)[0])
        self.assertEqual(self.run_at(12, 41), [])
        self.assertEqual(self.run_at(12, 50), [])

    def test_too_late(self):
        self.add(1, warn=1)
        self.assertEqual(self.run_at(12, 56), [])

    def test_schedule_changed_shortly_before(self):
        self.add(1, warn=1, days=["yes"] * 14 + ["no"] * 4 + ["yes"] * 4 + ["no"] * 2)
        self.run_at(12, 50)
        t = self.texts(1)
        self.assertIn("Змінився графік", t[0])
        self.assertIn("Залишилось 10 хв · графік щойно змінився", t[1])

    def test_half_hours_and_short_window(self):
        self.today = ["yes"] * 13 + ["first"] + ["no"] * 4 + ["second"] + ["no"] * 5
        self.add(1, warn=1, days=self.today)
        self.run_at(17, 30)
        self.assertIn("світло буде до 18:30 (30 хв)", self.texts(1)[0])

    def test_midnight(self):
        self.tomorrow = ["no", "no"] + ["yes"] * 22
        self.add(1, warn=1)
        self.con.execute("UPDATE users SET last_days = ? WHERE chat_id = 1", (json.dumps(
            {DAY.date().isoformat(): TODAY, (DAY + timedelta(days=1)).date().isoformat(): self.tomorrow}),))
        self.con.commit()
        self.run_at(21, 30)
        self.assertIn("світла не буде до 02:00 завтра (4 год)", self.texts(1)[0])

    def test_switch_at_midnight(self):
        self.today, self.tomorrow = ["yes"] * 20 + ["no"] * 4, ["yes"] * 24
        self.add(1, warn=1, days=self.today)
        self.con.execute("UPDATE users SET last_days = ? WHERE chat_id = 1", (json.dumps(
            {DAY.date().isoformat(): self.today, (DAY + timedelta(days=1)).date().isoformat(): self.tomorrow}),))
        self.con.commit()
        self.run_at(23, 30)
        self.assertTrue(self.texts(1)[0].startswith("🟢 00:00 (завтра) — увімкнення"))

    def test_quiet_night(self):
        self.today = ["no", "no"] + ["yes"] * 5 + ["no"] + ["yes"] * 16
        self.add(1, warn=1, days=self.today)
        self.run_at(1, 30)
        self.assertTrue(self.sent[0]["silent"])
        self.run_at(7, 30)
        self.assertFalse(self.sent[0]["silent"])

    def test_keyboard_reflects_setting(self):
        self.add(1, warn=1)
        self.add(2, warn=0)
        self.today = ["yes"] * 14 + ["no"] * 4 + ["yes"] * 4 + ["no"] * 2
        self.run_at(9, 0)
        kb = {m["cid"]: m["kb"]["keyboard"][1][0]["text"] for m in self.sent}
        self.assertEqual(kb, {1: "🔕 Не попереджати про світло", 2: "⏰ Попереджати про світло"})

    # ---------------------------------------------------------------- доставка

    def test_undelivered_retried_next_time(self):
        self.add(1, warn=1)
        self.fail_for[1] = "error"
        self.run_at(12, 30)
        self.assertIsNone(self.row(1)["warned"])
        self.fail_for.clear()
        self.run_at(12, 40)
        self.assertIn("Залишилось 20 хв", self.texts(1)[0])

    def test_blocked_user_unsubscribed(self):
        self.add(1)
        self.fail_for[1] = "blocked"
        self.today = ["yes"] * 24
        self.run_at(9, 0)
        self.assertEqual(self.row(1)["state"], "stopped")

    def test_telegram_network_errors_retried(self):
        calls = []

        def flaky(url, data=None, headers=None, method=None):
            calls.append(1)
            if len(calls) < 3:
                raise ConnectionResetError(104, "Connection reset by peer")
            return {"ok": True}

        orig_http, orig_sleep = check.http_json, check.time.sleep
        check.http_json, check.time.sleep = flaky, (lambda s: None)
        try:
            self.assertEqual(self.patches["tg_send"](1, "x"), "ok")
            self.assertEqual(len(calls), 3)
        finally:
            check.http_json, check.time.sleep = orig_http, orig_sleep

    # ---------------------------------------------------------------- розсилка

    def test_broadcast(self):
        self.add(42)
        self.add(1)
        self.con.execute("INSERT INTO users (chat_id, state) VALUES (3, 'stopped')")
        self.con.execute("INSERT INTO meta (key, value) VALUES ('broadcast', ?)",
                         (json.dumps({"html": "📢 Тест", "admin": 42}),))
        self.con.commit()
        self.run_at(9, 0)
        self.assertEqual(sorted(m["cid"] for m in self.sent if m["text"] == "📢 Тест"), [1, 42])
        self.assertIn("Розсилку надіслано: 2 з 2", self.texts(42)[-1])
        self.assertEqual(self.con.execute("SELECT count(*) FROM meta WHERE key = 'broadcast'").fetchone()[0], 0)

    # ---------------------------------------------------------------- навантаження

    def test_many_users_few_db_queries(self):
        for i in range(300):
            self.add(1000 + i, warn=i % 2)
        calls = []
        orig = check.D1.q

        def counting(self_, sql, *p):
            calls.append(sql)
            return orig(self_, sql, *p)

        check.D1.q = counting
        self.tomorrow = ["yes"] * 24
        self.run_at(12, 30)
        self.assertLessEqual(len(calls), 10)
        self.assertEqual(len(self.sent), 300 + 150)  # графік на завтра всім + попередження половині


if __name__ == "__main__":
    unittest.main()
