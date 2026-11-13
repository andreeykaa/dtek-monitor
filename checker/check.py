"""
ДТЕК Монітор — перевірка графіків (запускається GitHub Actions кожні 10 хв).

1. Бере з бази Cloudflare D1 користувачів (активних і тих, чию адресу треба перевірити).
2. Відкриває сайт ДТЕК у браузері, отримує графік усіх груп і будинки потрібних вулиць.
3. Нові адреси — підтверджує (або просить ввести ще раз).
   Активні — порівнює з попереднім графіком і надсилає зміни в Telegram.
4. Оновлює список вулиць для пошуку в боті.

Змінні середовища: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, TELEGRAM_BOT_TOKEN.
"""

import hashlib
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

URL = "https://www.dtek-kem.com.ua/ua/shutdowns"
DB_NAME = "dtek-monitor"
KYIV = ZoneInfo("Europe/Kyiv")

CF_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "")
CF_ACCOUNT = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
TG_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")

MAIN_KEYBOARD = {
    "keyboard": [[{"text": "📅 Графік"}, {"text": "📍 Змінити адресу"}]],
    "resize_keyboard": True,
    "is_persistent": True,
}

# Значення комірки години -> дві півгодини: "+" світло є, "-" немає, "?" можливо немає
HALF = {
    "yes": "++", "no": "--", "first": "-+", "second": "+-",
    "maybe": "??", "mfirst": "?+", "msecond": "+?",
}
PERIOD = {"+": ("🟢", "світло"), "-": ("🔴", "без світла"), "?": ("🟡", "можливо без світла")}
WEEKDAYS = ["пн", "вт", "ср", "чт", "пт", "сб", "нд"]


def anon(chat_id) -> str:
    """Анонімна мітка користувача для журналу (журнали публічні!)."""
    return "user-" + hashlib.sha256(f"{TG_TOKEN}:{chat_id}".encode()).hexdigest()[:6]


def log(msg: str) -> None:
    print(f"[{datetime.now(KYIV):%H:%M:%S}] {msg}", flush=True)


# ============================================================ HTTP / API

def http_json(url, data=None, headers=None, method=None):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, body, method=method or ("POST" if body else "GET"))
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return json.load(e)
        except Exception:
            raise RuntimeError(f"HTTP {e.code} {url.split('?')[0]}") from None


class D1:
    def __init__(self):
        self.base = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT}/d1/database"
        self.auth = {"Authorization": f"Bearer {CF_TOKEN}"}
        res = http_json(f"{self.base}?name={DB_NAME}", headers=self.auth)
        dbs = [d for d in res.get("result") or [] if d.get("name") == DB_NAME]
        if not dbs:
            raise RuntimeError(f"База D1 '{DB_NAME}' не знайдена — спершу запустіть розгортання бота")
        self.url = f"{self.base}/{dbs[0]['uuid']}/query"

    def q(self, sql, *params):
        res = http_json(self.url, {"sql": sql, "params": list(params)}, self.auth)
        if not res.get("success"):
            raise RuntimeError(f"D1: {res.get('errors')}")
        return res["result"][0].get("results", [])


def tg_send(chat_id, text, keyboard=True) -> str:
    """-> 'ok' | 'blocked' | 'error'"""
    payload = {
        "chat_id": chat_id, "text": text, "parse_mode": "HTML",
        "link_preview_options": {"is_disabled": True},
    }
    if keyboard:
        payload["reply_markup"] = MAIN_KEYBOARD
    for _ in range(3):
        res = http_json(f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage", payload)
        if res.get("ok"):
            return "ok"
        code = res.get("error_code")
        if code == 429:
            time.sleep((res.get("parameters") or {}).get("retry_after", 3) + 1)
            continue
        if code == 403 or "chat not found" in str(res.get("description", "")):
            return "blocked"
        log(f"Telegram {anon(chat_id)}: {res.get('description')}")
        return "error"
    return "error"


# ============================================================ сайт ДТЕК

FETCH_JS = r"""
async ({streets}) => {
  const meta = n => document.querySelector(`meta[name="${n}"]`)?.content;
  const ajaxUrl = meta('ajaxUrl') || '/ua/ajax';
  const csrf = meta('csrf-token');
  let fact = null, allStreets = null;
  try {
    if (typeof DisconSchedule !== 'undefined') {
      fact = DisconSchedule.fact || null;
      allStreets = DisconSchedule.streets || null;
    }
  } catch (e) {}
  if (!fact) {
    const m = document.documentElement.outerHTML
      .match(/DisconSchedule\.fact\s*=\s*(\{[\s\S]*?\})\s*(?:;|<\/script>)/);
    if (m) { try { fact = JSON.parse(m[1]); } catch (e) {} }
  }
  const houses = {};
  for (const street of streets) {
    const body = new URLSearchParams();
    body.append('data[0][name]', 'street');
    body.append('data[0][value]', street);
    body.append('method', 'getHomeNum');
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
    };
    if (csrf) headers['X-CSRF-Token'] = csrf;
    try {
      const r = await fetch(ajaxUrl, {method: 'POST', body, headers, credentials: 'same-origin'});
      const text = await r.text();
      try { houses[street] = JSON.parse(text); }
      catch (e) { houses[street] = {error: `HTTP ${r.status}: ${text.slice(0, 200)}`}; }
    } catch (e) { houses[street] = {error: String(e)}; }
    await new Promise(r => setTimeout(r, 400));
  }
  return {fact, allStreets, houses};
}
"""


def fetch_site(streets):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(headless=True, channel="chromium")
        except Exception:
            browser = p.chromium.launch(headless=True)
        ua = (f"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              f"(KHTML, like Gecko) Chrome/{browser.version} Safari/537.36")
        page = browser.new_context(locale="uk-UA", timezone_id="Europe/Kyiv", user_agent=ua).new_page()
        try:
            last_err = None
            for attempt in range(3):
                try:
                    page.goto(URL, wait_until="domcontentloaded", timeout=60000)
                    page.wait_for_function(
                        "() => document.querySelector('meta[name=\"ajaxUrl\"]') || window.DisconSchedule",
                        timeout=45000,
                    )
                    page.wait_for_timeout(1500)
                    return page.evaluate(FETCH_JS, {"streets": sorted(streets)})
                except Exception as e:
                    last_err = e
                    log(f"Спроба {attempt + 1}: {str(e).splitlines()[0]}")
                    page.wait_for_timeout(5000)
            raise RuntimeError(f"Сайт ДТЕК не завантажився: {last_err}")
        finally:
            browser.close()


def flatten_streets(raw) -> list:
    out = set()
    if isinstance(raw, dict):
        for v in raw.values():
            out.update(flatten_streets(v))
    elif isinstance(raw, list):
        for v in raw:
            if isinstance(v, str):
                out.add(v.strip())
            else:
                out.update(flatten_streets(v))
    return sorted(s for s in out if s)


# ============================================================ графік

def day_key(ts) -> str:
    return datetime.fromtimestamp(int(ts), KYIV).date().isoformat()


def days_for(fact, group) -> dict:
    """-> {"YYYY-MM-DD": [24 значення]} для групи"""
    out = {}
    for ts, day in (fact.get("data") or {}).items():
        hours = (day or {}).get(group)
        if hours:
            out[day_key(ts)] = [hours.get(str(h)) for h in range(1, 25)]
    return out


def halves_of(hours) -> str:
    return "".join(HALF.get(v, "??") for v in hours)


def runs(halves, chars):
    res, i = [], 0
    while i < 48:
        ch, j = halves[i], i
        while j < 48 and halves[j] == ch:
            j += 1
        if ch in chars:
            res.append((i, j, ch))
        i = j
    return res


def hm(k):
    return f"{k // 2:02d}:{'30' if k % 2 else '00'}"


def dur(n):
    return f"{n / 2:g}".replace(".", ",") + " год"


def describe(hours):
    parts = [f"{hm(a)}–{hm(b)}" + (" (можливо)" if c == "?" else "")
             for a, b, c in runs(halves_of(hours), "-?")]
    return ", ".join(parts) if parts else "відключень немає"


def group_name(g):
    m = re.match(r"^GPV(\d+)\.\d+$", g or "")
    return m.group(1) if m else (g or "").replace("GPV", "")


def day_html(d_iso, label, hours, tag="", old=None):
    dt = datetime.fromisoformat(d_iso)
    lines = [f"📅 <b>{label.capitalize()}, {WEEKDAYS[dt.weekday()]} {dt:%d.%m}</b>" + (f"  {tag}" if tag else "")]
    h = halves_of(hours)
    if "-" not in h and "?" not in h:
        lines.append("✅ Відключень немає")
    else:
        for a, b, c in runs(h, "+-?"):
            icon, what = PERIOD[c]
            lines.append(f"{icon} <b>{hm(a)}–{hm(b)}</b> · {what} {dur(b - a)}")
        maybe = f" · можливо {dur(h.count('?'))}" if "?" in h else ""
        lines.append(f"<i>Разом: світло {dur(h.count('+'))} · без світла {dur(h.count('-'))}{maybe}</i>")
    if old and old != hours:
        lines.append(f"<i>Було: {describe(old)}</i>")
    return "\n".join(lines)


def header_html(title, street, house, group):
    grp = f" · група {html.escape(group_name(group))}" if group else ""
    return f"⚡ <b>{title}</b>\n📍 {html.escape(f'{street}, {house}')}{grp}"


def footer_html(update):
    upd = html.escape(update) if update else "—"
    return f'<i>Оновлено ДТЕК: {upd}</i> · <a href="{URL}">сайт</a>'


def today_tomorrow():
    t = datetime.now(KYIV).date()
    return ((t.isoformat(), "сьогодні"), ((t + timedelta(days=1)).isoformat(), "завтра"))


def status_text(u, days, update):
    blocks = []
    for d, label in today_tomorrow():
        if d in days:
            blocks.append(day_html(d, label, days[d]))
        elif label == "завтра":
            blocks.append("<i>Графік на завтра ще не опубліковано</i>")
    if not any(d in days for d, _ in today_tomorrow()):
        blocks = ["Графіків поки немає."]
    return "\n\n".join([header_html("Графік відключень", u["street"], u["house"], u["grp"])]
                       + blocks + [footer_html(update)])


# ============================================================ адреси

LATIN = str.maketrans({"a": "а", "b": "б", "v": "в", "g": "г", "e": "е", "c": "с", "k": "к", "o": "о"})


def norm_house(s):
    return re.sub(r"[\s\-]", "", str(s).lower()).translate(LATIN)


def find_house(houses: dict, house: str):
    if house in houses:
        return house
    n = norm_house(house)
    for k in houses:
        if norm_house(k) == n:
            return k
    return None


def similar_houses(houses: dict, house: str, limit=15):
    m = re.match(r"\d+", norm_house(house))
    keys = [k for k in houses if m and re.match(rf"{m.group(0)}(\D|$)", norm_house(k))]
    if not keys:
        keys = list(houses)
    return keys[:limit]


# ============================================================ основне

def main() -> int:
    missing = [n for n, v in (("CLOUDFLARE_API_TOKEN", CF_TOKEN), ("CLOUDFLARE_ACCOUNT_ID", CF_ACCOUNT),
                              ("TELEGRAM_BOT_TOKEN", TG_TOKEN)) if not v]
    if missing:
        log(f"Не задано секрети: {', '.join(missing)}")
        return 1

    db = D1()
    users = db.q("SELECT chat_id, state, street, house, grp, last_days, last_text FROM users "
                 "WHERE state IN ('active', 'pending') AND street IS NOT NULL AND house IS NOT NULL")
    log(f"Користувачів: {len(users)} (нових адрес: {sum(u['state'] == 'pending' for u in users)})")

    site = fetch_site({u["street"] for u in users})
    fact = site.get("fact") or {}
    if not fact.get("data"):
        raise RuntimeError("На сторінці не знайдено графік (DisconSchedule.fact)")
    update = fact.get("update", "")

    # --- список вулиць для пошуку в боті
    streets = flatten_streets(site.get("allStreets"))
    if streets:
        h = hashlib.sha256("\n".join(streets).encode()).hexdigest()
        prev = db.q("SELECT value FROM meta WHERE key = 'streets_hash'")
        if not prev or prev[0]["value"] != h:
            db.q("DELETE FROM streets")
            for i in range(0, len(streets), 90):
                chunk = streets[i:i + 90]
                db.q("INSERT OR IGNORE INTO streets (name) VALUES " + ",".join(["(?)"] * len(chunk)), *chunk)
            db.q("INSERT INTO meta (key, value) VALUES ('streets_hash', ?) "
                 "ON CONFLICT(key) DO UPDATE SET value = excluded.value", h)
            log(f"Оновлено список вулиць: {len(streets)}")
    else:
        log("⚠️ Список вулиць на сторінці не знайдено")

    sent = 0
    for u in users:
        cid, street, house = u["chat_id"], u["street"], u["house"]
        resp = site["houses"].get(street) or {}
        if resp.get("error"):
            log(f"{anon(cid)}: помилка запиту вулиці")
            continue
        houses = resp.get("data") or {}
        guard = ("chat_id = ? AND state = ? AND street = ? AND house = ?", cid, u["state"], street, house)

        # ---------- нова адреса: перевірка
        if u["state"] == "pending":
            if not houses:
                db.q(f"UPDATE users SET state = 'awaiting_street', updated_at = CURRENT_TIMESTAMP WHERE {guard[0]}", *guard[1:])
                tg_send(cid, f"😕 Не вдалося знайти вулицю «{html.escape(street)}» на сайті ДТЕК.\n\n"
                             "Введіть назву вулиці ще раз.", keyboard=False)
                continue
            key = find_house(houses, house)
            if key is None:
                db.q(f"UPDATE users SET state = 'awaiting_house', updated_at = CURRENT_TIMESTAMP WHERE {guard[0]}", *guard[1:])
                sim = ", ".join(similar_houses(houses, house))
                tg_send(cid, f"😕 Будинок <b>{html.escape(house)}</b> не знайдено на {html.escape(street)}.\n\n"
                             f"Є, наприклад: {html.escape(sim)}\n\nВведіть номер будинку ще раз.", keyboard=False)
                continue
            groups = houses[key].get("sub_type_reason") or []
            grp = groups[0] if groups else ""
            days = days_for(fact, grp) if grp else {}
            u2 = {**u, "house": key, "grp": grp}
            text = status_text(u2, days, update)
            if grp:
                intro = (f"✅ <b>Адресу підтверджено!</b>\n📍 {html.escape(street)}, {html.escape(key)} · "
                         f"група {html.escape(group_name(grp))}\n\n"
                         "🔔 Я напишу, коли графік на сьогодні зміниться або з'явиться графік на завтра.")
            else:
                intro = (f"✅ Адресу знайдено: {html.escape(street)}, {html.escape(key)}\n\n"
                         "⚠️ Але ДТЕК не вказує для цього будинку групу відключень, тому графік відстежити не вийде.")
            db.q(f"UPDATE users SET state = 'active', house = ?, grp = ?, last_days = ?, last_text = ?, "
                 f"updated_at = CURRENT_TIMESTAMP WHERE {guard[0]}",
                 key, grp, json.dumps(days), text if grp else None, *guard[1:])
            tg_send(cid, intro)
            if grp:
                tg_send(cid, text)
            sent += 1
            log(f"{anon(cid)}: адресу підтверджено ({group_name(grp) or 'без групи'})")
            continue

        # ---------- активний: пошук змін
        key = find_house(houses, house)
        if key is None:
            log(f"{anon(cid)}: будинок зник зі списку ДТЕК — пропускаю")
            continue
        groups = houses[key].get("sub_type_reason") or []
        grp = groups[0] if groups else ""
        if not grp:
            continue
        days = days_for(fact, grp)
        old_days = json.loads(u["last_days"] or "{}")
        blocks, titles = [], []
        for d, label in today_tomorrow():
            new, old = days.get(d), old_days.get(d)
            if new is None:
                continue
            if old is None:
                blocks.append(day_html(d, label, new, tag="🆕"))
                titles.append(f"З'явився графік на {label}")
            elif old != new:
                blocks.append(day_html(d, label, new, tag="🔄", old=old))
                titles.append(f"Змінився графік на {label}")
        if u["grp"] and grp != u["grp"]:
            titles = [f"Змінилась група ({group_name(u['grp'])} → {group_name(grp)})"]
            blocks = [day_html(d, label, days[d]) for d, label in today_tomorrow() if d in days]

        text = status_text({**u, "grp": grp}, days, update)
        if blocks:
            msg = "\n\n".join([header_html(" · ".join(titles), street, house, grp)]
                              + blocks + [footer_html(update)])
            if tg_send(cid, msg) == "blocked":
                db.q(f"UPDATE users SET state = 'stopped' WHERE {guard[0]}", *guard[1:])
                log(f"{anon(cid)}: заблокував бота — відписано")
                continue
            sent += 1
        keep = {d: v for d, v in {**old_days, **days}.items() if d >= today_tomorrow()[0][0]}
        if keep != old_days or text != u["last_text"] or grp != u["grp"]:
            db.q(f"UPDATE users SET grp = ?, last_days = ?, last_text = ? WHERE {guard[0]}",
                 grp, json.dumps(keep), text, *guard[1:])

    log(f"Готово. Надіслано повідомлень: {sent}. Оновлено ДТЕК: {update}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
