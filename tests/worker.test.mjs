// Тести Telegram-бота (worker/src/index.js).
// Запуск: node --test tests/
// Telegram і GitHub замінено заглушками, база D1 — SQLite у пам'яті (node:sqlite, Node 22+).

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker, { norm, searchStreets, splitHouse, parseGhDate, groupLabel, whenLight, fmtLeft, kyivNow } from "../worker/src/index.js";

const SCHEMA = fs.readFileSync(new URL("../worker/schema.sql", import.meta.url), "utf8");
const ADMIN = 42;

// ------------------------------------------------------------ середовище

let db, sent, edited, dispatched, ghStatus, ghExpiry, msgId;

function makeD1(database) {
  return {
    prepare(sql) {
      const st = database.prepare(sql);
      let args = [];
      const o = {
        bind: (...a) => ((args = a), o),
        first: async () => st.get(...args) ?? null,
        all: async () => ({ results: st.all(...args) }),
        run: async () => (st.run(...args), {}),
      };
      return o;
    },
  };
}

const env = () => ({
  DB: makeD1(db),
  TELEGRAM_BOT_TOKEN: "T",
  WEBHOOK_SECRET: "S",
  GH_TOKEN: "g",
  GH_REPO: "owner/repo",
  ADMIN_CHAT_ID: String(ADMIN),
});

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  for (const n of ["просп. Голосіївський", "вул. Голосіївська", "вул. Хрещатик", "вул. 8 Березня"]) {
    db.prepare("INSERT INTO streets (name) VALUES (?)").run(n);
  }
  sent = [];
  edited = 0;
  dispatched = [];
  ghStatus = 204;
  ghExpiry = null;
  msgId = 100;
  globalThis.fetch = async (url, init) => {
    if (url.includes("api.github.com")) {
      dispatched.push(JSON.parse(init.body).inputs?.reason);
      const headers = new Headers();
      if (ghExpiry) headers.set("github-authentication-token-expiration", ghExpiry);
      return new Response(ghStatus === 204 ? null : "err", { status: ghStatus, headers });
    }
    const method = url.split("/").pop();
    const body = JSON.parse(init.body);
    if (method === "sendMessage") {
      sent.push(body);
      return Response.json({ ok: true, result: { message_id: ++msgId } });
    }
    if (method === "editMessageReplyMarkup") edited++;
    return Response.json({ ok: true });
  };
});

async function call(update, e = env()) {
  const waits = [];
  const res = await worker.fetch(
    new Request("https://x/telegram", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "S" },
      body: JSON.stringify(update),
    }),
    e,
    { waitUntil: (p) => waits.push(p) }
  );
  await Promise.all(waits);
  return res;
}
const msg = (id, text, extra = {}) => call({ message: { chat: { id, type: "private" }, from: {}, text, ...extra } });
const tap = (id, data) => call({ callback_query: { id: "q", data, message: { chat: { id }, message_id: 1 } } });
const user = (id) => db.prepare("SELECT * FROM users WHERE chat_id = ?").get(id);
const last = () => sent.at(-1);
const plain = (m) => m.text.replace(/<[^>]+>/g, "");
const addActive = (id, extra = {}) => {
  const u = { state: "active", street: "просп. Голосіївський", house: "7", grp: "GPV33.1", last_text: "ГРАФІК", warn: 0, ...extra };
  db.prepare("INSERT INTO users (chat_id, state, street, house, grp, last_text, warn) VALUES (?,?,?,?,?,?,?)")
    .run(id, u.state, u.street, u.house, u.grp, u.last_text, u.warn);
};

// ------------------------------------------------------------ чисті функції

describe("пошук вулиць і розбір адреси", () => {
  test("norm прибирає «вул.», «просп.» і апострофи", () => {
    assert.equal(norm("просп. Голосіївський"), "голосіївський");
    assert.equal(norm("вул. Об'єднання"), "обєднання");
  });
  test("searchStreets: точний збіг першим", () => {
    const streets = ["просп. Голосіївський", "вул. Голосіївська", "пров. Голосіївський"].map((name, id) => ({ id, name }));
    const r = searchStreets(streets, "просп. Голосіївський");
    assert.equal(r.items[0].name, "просп. Голосіївський");
    assert.equal(searchStreets(streets, "голосіїв").total, 3);
    assert.equal(searchStreets(streets, "нема такої").total, 0);
  });
  test("splitHouse відокремлює номер будинку", () => {
    assert.deepEqual(splitHouse("Голосіївський 7"), { street: "Голосіївський", house: "7" });
    assert.deepEqual(splitHouse("просп. Голосіївський, 7а"), { street: "просп. Голосіївський", house: "7а" });
    assert.deepEqual(splitHouse("Генерала Наумова 23-б"), { street: "Генерала Наумова", house: "23б" });
    assert.deepEqual(splitHouse("Хрещатик буд. 5/2"), { street: "Хрещатик", house: "5/2" });
    assert.equal(splitHouse("Голосіївський"), null);
    assert.equal(splitHouse("8 Березня"), null);
  });
  test("parseGhDate і groupLabel", () => {
    assert.equal(parseGhDate("2026-12-13 16:15:00 +0200").toISOString(), "2026-12-13T14:15:00.000Z");
    assert.equal(parseGhDate("2026-12-13 14:15:00 UTC").toISOString(), "2026-12-13T14:15:00.000Z");
    assert.equal(parseGhDate("сміття"), null);
    assert.equal(groupLabel("GPV33.1"), "33");
  });
});

// ------------------------------------------------------------ безпека

describe("безпека", () => {
  test("запит без секретного заголовка відхиляється", async () => {
    const res = await worker.fetch(new Request("https://x/telegram", { method: "POST", body: "{}" }), env(), {
      waitUntil() {},
    });
    assert.equal(res.status, 403);
  });
});

// ------------------------------------------------------------ реєстрація

describe("реєстрація адреси", () => {
  test("вулиця → кнопка → будинок → перевірка", async () => {
    await msg(1, "/start");
    assert.match(last().text, /Вас вітає/);
    await msg(1, "Хрещатик");
    const kb = last().reply_markup.inline_keyboard;
    assert.equal(kb[0][0].text, "вул. Хрещатик");
    await tap(1, kb[0][0].callback_data);
    assert.match(last().text, /номер будинку/);
    await msg(1, "5");
    assert.equal(user(1).state, "pending");
    assert.equal(user(1).house, "5");
    assert.deepEqual(dispatched, ["address"]);
  });
  test("вулиця з номером — номер не питається вдруге", async () => {
    await msg(1, "/start");
    await msg(1, "просп. Голосіївський, 7а");
    assert.match(last().text, /Будинок <b>7а<\/b>/);
    await tap(1, last().reply_markup.inline_keyboard[0][0].callback_data);
    assert.equal(user(1).state, "pending");
    assert.equal(user(1).house, "7а");
  });
  test("вулиця з цифрою в назві («8 Березня») не ламається", async () => {
    await msg(1, "/start");
    await msg(1, "8 Березня");
    await tap(1, last().reply_markup.inline_keyboard[0][0].callback_data);
    assert.equal(user(1).state, "awaiting_house");
  });
  test("/address скидає запам'ятований номер", async () => {
    await msg(1, "/start");
    await msg(1, "Голосіївський 9");
    await msg(1, "/address");
    await msg(1, "Хрещатик");
    await tap(1, last().reply_markup.inline_keyboard[0][0].callback_data);
    assert.equal(user(1).state, "awaiting_house");
  });
  test("імена користувачів не зберігаються", async () => {
    await call({ message: { chat: { id: 1, type: "private" }, from: { first_name: "Андрій" }, text: "/start" } });
    assert.equal(user(1).name, null);
  });
});

// ------------------------------------------------------------ команди користувача

describe("команди користувача", () => {
  test("/stop зберігає дані, /start відновлює", async () => {
    addActive(1, { warn: 1 });
    await msg(1, "/stop");
    assert.equal(user(1).state, "stopped");
    await msg(1, "/start");
    assert.equal(user(1).state, "active");
    assert.equal(user(1).warn, 1);
    assert.equal(last().reply_markup.keyboard.at(-1)[0].text, "🔕 Не попереджати про світло");
  });
  test("/delete з підтвердженням", async () => {
    addActive(1);
    await msg(1, "/delete");
    await tap(1, "del:no");
    assert.ok(user(1));
    await msg(1, "/delete");
    await tap(1, "del:yes");
    assert.equal(user(1), undefined);
  });
  test("📅 Графік показує збережений графік", async () => {
    addActive(1);
    await msg(1, "📅 Графік");
    assert.equal(last().text, "ГРАФІК");
  });
});

// ------------------------------------------------------------ попередження про світло

describe("попередження про світло", () => {
  test("кнопка вмикає/вимикає і змінюється", async () => {
    addActive(1);
    await msg(1, "⏰ Попереджати про світло");
    assert.equal(user(1).warn, 1);
    assert.match(last().text, /Попередження про світло увімкнено/);
    assert.equal(last().reply_markup.keyboard.at(-1)[0].text, "🔕 Не попереджати про світло");
    await msg(1, "🔕 Не попереджати про світло");
    assert.equal(user(1).warn, 0);
    assert.match(last().text, /вимкнено/);
    assert.equal(last().reply_markup.keyboard.at(-1)[0].text, "⏰ Попереджати про світло");
  });
  test("«Ні, дякую» лише прибирає кнопки", async () => {
    addActive(1);
    const before = sent.length;
    await tap(1, "warn:no");
    assert.equal(sent.length, before);
    assert.equal(edited, 1);
    assert.equal(user(1).warn, 0);
  });
  test("повторне натискання — «вже увімкнено»", async () => {
    addActive(1, { warn: 1 });
    await tap(1, "warn:on");
    assert.match(last().text, /вже увімкнено/);
  });
  test("до завершення реєстрації — «спершу вкажіть адресу»", async () => {
    db.prepare("INSERT INTO users (chat_id, state) VALUES (2, 'awaiting_house')").run();
    await msg(2, "⏰ Попереджати про світло");
    assert.match(last().text, /Спершу вкажіть адресу/);
  });
});

// ------------------------------------------------------------ адмін

describe("адмін: /broadcast і /stats", () => {
  test("звичайний користувач не має доступу", async () => {
    addActive(1);
    await msg(1, "/broadcast привіт");
    assert.doesNotMatch(last().text, /побачать/);
    await msg(1, "/stats");
    assert.doesNotMatch(last().text, /Статистика/);
    await tap(1, "bc:send");
    assert.equal(db.prepare("SELECT count(*) AS n FROM meta WHERE key = 'broadcast'").get().n, 0);
  });
  test("розсилка: перегляд → скасування → відправка", async () => {
    addActive(ADMIN);
    addActive(1);
    await msg(ADMIN, "/broadcast Тест <розсилки>");
    assert.match(last().text, /2 активних/);
    assert.match(last().text, /&lt;розсилки&gt;/);
    await tap(ADMIN, "bc:no");
    await msg(ADMIN, "/broadcast Тест");
    await tap(ADMIN, "bc:send");
    const bc = JSON.parse(db.prepare("SELECT value FROM meta WHERE key = 'broadcast'").get().value);
    assert.match(bc.html, /Тест/);
    assert.deepEqual(dispatched, ["broadcast"]);
  });
  test("/stats рахує стани", async () => {
    addActive(ADMIN, { warn: 1 });
    addActive(1);
    db.prepare("INSERT INTO users (chat_id, state) VALUES (2, 'awaiting_street')").run();
    db.prepare("INSERT INTO users (chat_id, state) VALUES (3, 'stopped')").run();
    db.prepare(
      "INSERT INTO users (chat_id, state, updated_at) VALUES (4, 'awaiting_house', datetime('now', '-3 days'))"
    ).run();
    db.prepare("INSERT INTO meta (key, value) VALUES ('nf:' || date('now', '-10 days'), '5')").run();
    await msg(5, "/start");
    await msg(5, "Неіснуюча");
    await msg(5, "Теж неіснуюча");
    await msg(ADMIN, "/stats");
    const t = plain(last());
    assert.match(t, /Усього: 6/);
    assert.match(t, /Активні: 2 · ⏰ з попередженнями: 1/);
    assert.match(t, /Реєструються: 2 · покинули реєстрацію: 1/);
    assert.match(t, /Не знайдено вулицю за 7 днів: 2/);
    assert.match(t, /Відписані: 1/);
    assert.match(t, /33 — 2/);
  });
});

describe("адмін: /remind", () => {
  const abandoned = (id, state, street = null) =>
    db.prepare(
      "INSERT INTO users (chat_id, state, street, updated_at) VALUES (?, ?, ?, datetime('now', '-2 days'))"
    ).run(id, state, street);

  test("недоступна звичайним користувачам", async () => {
    abandoned(2, "awaiting_street");
    await msg(1, "/remind");
    assert.ok(!sent.some((m) => m.chat_id === 2));
    assert.doesNotMatch(last().text, /Нагадування отримають/);
  });

  test("показує кількість, надсилає один раз, правильний текст для кроку", async () => {
    abandoned(2, "awaiting_street");
    abandoned(3, "awaiting_house", "вул. Хрещатик");
    db.prepare("INSERT INTO users (chat_id, state) VALUES (4, 'awaiting_street')").run(); // свіжий — не чіпаємо
    addActive(5);
    await msg(ADMIN, "/remind");
    assert.match(plain(last()), /Нагадування отримають 2 .*на вулиці: 1, на будинку: 1/s);
    sent = [];
    await tap(ADMIN, "rm:send");
    const to = (id) => sent.find((m) => m.chat_id === id);
    assert.match(to(2).text, /Залишилось вказати адресу/);
    assert.match(to(3).text, /номер будинку на вулиці вул\. Хрещатик/);
    assert.ok(!to(4) && !to(5));
    assert.match(plain(last()), /Нагадування надіслано: 2/);
    await msg(ADMIN, "/remind");
    assert.match(last().text, /Нікому нагадувати/);
  });

  test("скасування нічого не надсилає", async () => {
    abandoned(2, "awaiting_street");
    await msg(ADMIN, "/remind");
    sent = [];
    await tap(ADMIN, "rm:no");
    assert.ok(!sent.some((m) => m.chat_id === 2));
  });
});

describe("відгуки", () => {
  test("/feedback текст → адмін → Reply → користувач", async () => {
    addActive(1);
    await msg(1, "/feedback Бот класний");
    const toAdmin = sent.find((m) => m.chat_id === String(ADMIN));
    assert.match(toAdmin.text, /Бот класний/);
    assert.match(toAdmin.text, /просп\. Голосіївський, 7/);
    assert.match(last().text, /Дякую/);
    const adminMsgId = msgId - 1; // повідомлення адміну було перед «Дякую»
    await msg(ADMIN, "Дякую за відгук!", { reply_to_message: { message_id: adminMsgId } });
    const toUser = sent.find((m) => m.chat_id === "1" && /Відповідь адміністратора/.test(m.text));
    assert.ok(toUser, "відповідь дійшла користувачу");
    assert.match(last().text, /Відповідь надіслано/);
  });
  test("/feedback без тексту → наступне повідомлення", async () => {
    addActive(1);
    await msg(1, "/feedback");
    assert.match(last().text, /Напишіть одним повідомленням/);
    await msg(1, "Не знайшов свою вулицю");
    assert.ok(sent.some((m) => m.chat_id === String(ADMIN) && /Не знайшов свою вулицю/.test(m.text)));
  });
  test("кнопка меню під час очікування відгуку не пересилається", async () => {
    addActive(1);
    await msg(1, "/feedback");
    await msg(1, "📅 Графік");
    assert.ok(!sent.some((m) => m.chat_id === String(ADMIN)));
    assert.equal(last().text, "ГРАФІК");
  });
  test("не частіше ніж раз на 30 с", async () => {
    addActive(1);
    await msg(1, "/feedback раз");
    await msg(1, "/feedback два");
    assert.match(last().text, /Зачекайте/);
  });
});

// ------------------------------------------------------------ розклад (Cloudflare Cron)

describe("розклад", () => {
  const cron = async () => {
    const waits = [];
    await worker.scheduled({}, env(), { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  };
  test("запускає перевірку з причиною cron", async () => {
    await cron();
    assert.deepEqual(dispatched, ["cron"]);
  });
  test("одиночний збій — без попередження", async () => {
    ghStatus = 502;
    await cron();
    ghStatus = 204;
    await cron();
    assert.equal(sent.length, 0);
  });
  test("збій GitHub — одне попередження після двох невдач, потім «знову працює»", async () => {
    ghStatus = 500;
    await cron();
    await cron();
    await cron();
    const alerts = sent.filter((m) => /збій GitHub \(помилка 500\)/.test(m.text));
    assert.equal(alerts.length, 1);
    assert.match(alerts[0].text, /не запускаються з \d\d:\d\d\. Робити нічого не потрібно/);
    ghStatus = 204;
    await cron();
    assert.match(last().text, /знову запускаються \(перерва \d+ хв\)/);
  });
  test("недійсний токен — окремий текст", async () => {
    ghStatus = 401;
    await cron();
    await cron();
    assert.match(last().text, /не приймає токен .*помилка 401/s);
  });
  test("попередження про закінчення токена — раз на добу", async () => {
    ghExpiry = new Date(Date.now() + 5 * 86400000 + 3600e3).toISOString().replace("T", " ").slice(0, 19) + " UTC";
    await cron();
    await cron();
    assert.equal(sent.filter((m) => /GH_DISPATCH_TOKEN<\/code> закінчується/.test(m.text)).length, 1);
  });
});

// ------------------------------------------------------------ «Коли світло?»

describe("«Коли світло?»", () => {
  const D = "2026-11-17", T = "2026-11-18";
  const TODAY = [...Array(13).fill("yes"), ...Array(5).fill("no"), ...Array(4).fill("yes"), "no", "no"];
  const at = (hh, mm) => new Date(`${D}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+02:00`);
  const say = (days, t) => whenLight(JSON.stringify(days), t).replace(/<\/?[bi]>/g, "");

  test("світло є — до котрої і що далі", () => {
    assert.equal(say({ [D]: TODAY }, at(10, 45)),
      "🟢 Зараз за графіком світло є\nДо 13:00 — ще 2 год 15 хв\nДалі: 🔴 без світла 13:00–18:00 (5 год)");
  });
  test("світла немає — коли дадуть", () => {
    assert.equal(say({ [D]: TODAY }, at(14, 55)),
      "🔴 Зараз за графіком світла немає\nДадуть о 18:00 — через 3 год 5 хв\nДалі: 🟢 світло 18:00–22:00 (4 год)");
  });
  test("до кінця доби, графіка на завтра немає", () => {
    const t = say({ [D]: TODAY }, at(22, 30));
    assert.match(t, /За графіком — до кінця доби/);
    assert.match(t, /Графік на завтра ще не опубліковано/);
  });
  test("через північ", () => {
    assert.match(say({ [D]: TODAY, [T]: ["no", "no", ...Array(22).fill("yes")] }, at(22, 30)),
      /Дадуть завтра о 02:00 — через 3 год 30 хв/);
    assert.match(say({ [D]: [...Array(23).fill("yes"), "no"], [T]: ["no", ...Array(23).fill("yes")] }, at(21, 0)),
      /без світла 23:00–01:00 завтра \(2 год\)/);
    assert.match(say({ [D]: [...Array(20).fill("no"), ...Array(4).fill("yes")], [T]: Array(24).fill("no") }, at(20, 30)),
      /До 24:00 — ще 3 год 30 хв/);
  });
  test("без відключень і без графіка", () => {
    assert.match(say({ [D]: Array(24).fill("yes") }, at(9, 0)), /Відключень за графіком до кінця доби немає/);
    assert.equal(say({}, at(9, 0)), "Графіка на сьогодні поки немає.");
  });
  test("fmtLeft", () => {
    assert.equal(fmtLeft(45), "45 хв");
    assert.equal(fmtLeft(120), "2 год");
    assert.equal(fmtLeft(135), "2 год 15 хв");
  });
  test("кнопка відповідає активному і просить адресу в інших", async () => {
    db.prepare("INSERT INTO users (chat_id, state, street, house, grp, last_days) VALUES (1,'active','x','7','GPV33.1',?)")
      .run(JSON.stringify({ [kyivNow().date]: Array(24).fill("yes") }));
    await msg(1, "💡 Коли світло?");
    assert.match(last().text, /Зараз за графіком/);
    assert.equal(last().reply_markup.keyboard[0][0].text, "💡 Коли світло?");
    db.prepare("INSERT INTO users (chat_id, state) VALUES (2, 'awaiting_street')").run();
    await msg(2, "/light");
    assert.match(last().text, /Спершу вкажіть адресу/);
  });
});
