// ДТЕК Монітор — Telegram-бот (Cloudflare Worker).
// Веде діалог з користувачем і зберігає адреси в D1.
// Сам сайт ДТЕК перевіряє GitHub Actions (checker/check.py).

const BTN_SCHEDULE = "📅 Графік";
const BTN_ADDRESS = "📍 Змінити адресу";
const MAIN_KEYBOARD = {
  keyboard: [[{ text: BTN_SCHEDULE }, { text: BTN_ADDRESS }]],
  resize_keyboard: true,
  is_persistent: true,
};
const MAX_MATCHES = 8;

const WELCOME =
  "👋 Вас вітає <b>ДТЕК Монітор</b>!\n\n" +
  "Я стежу за графіком відключень <b>ДТЕК Київські електромережі</b> за вашою адресою " +
  "і надсилаю повідомлення, коли:\n" +
  "• змінюється графік на сьогодні;\n" +
  "• з'являється або змінюється графік на завтра.\n\n" +
  "Щоб я працював правильно, вкажіть адресу так само, як на офіційному сайті ДТЕК.";

const ASK_STREET =
  "📍 Введіть <b>лише назву вулиці</b>, без номера будинку — номер я попрошу наступним кроком.\n\n" +
  "✅ <i>Голосіївський</i>\n" +
  "❌ <i>Голосіївський 7</i>\n\n" +
  "Можна без «вул.» чи «просп.» — я запропоную точні варіанти з сайту ДТЕК.";

const HELP =
  "Що я вмію:\n" +
  `• <b>${BTN_SCHEDULE}</b> або /status — поточний графік\n` +
  `• <b>${BTN_ADDRESS}</b> або /address — вказати іншу адресу\n` +
  "• /stop — відписатися від сповіщень\n" +
  "• /delete — видалити всі ваші дані";

// ---------------------------------------------------------------- utils

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[’'ʼ`"«»]/g, "")
    .replace(/[^\s.]+\./g, " ") // «вул.», «просп.», «т.» тощо
    .replace(/[-–—,()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function searchStreets(streets, query, limit = MAX_MATCHES) {
  const q = norm(query);
  if (!q) return { total: 0, items: [] };
  const words = q.split(" ");
  const raw = String(query).toLowerCase().replace(/\s+/g, " ").trim();
  const found = [];
  for (const s of streets) {
    const n = s.norm ?? norm(s.name);
    if (!words.every((w) => n.includes(w))) continue;
    const exactRaw = s.name.toLowerCase().replace(/\s+/g, " ") === raw; // «просп. Голосіївський» повністю
    const rank = exactRaw ? -1 : n === q ? 0 : n.startsWith(q) ? 1 : (" " + n).includes(" " + q) ? 2 : 3;
    found.push({ ...s, rank, len: n.length });
  }
  found.sort((a, b) => a.rank - b.rank || a.len - b.len || a.name.localeCompare(b.name, "uk"));
  return { total: found.length, items: found.slice(0, limit) };
}

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!data.ok) console.error(`Telegram ${method}:`, JSON.stringify(data));
  return data;
}

const send = (env, chat_id, text, extra = {}) =>
  tg(env, "sendMessage", {
    chat_id,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...extra,
  });

// ---------------------------------------------------------------- db

const getUser = (env, id) => env.DB.prepare("SELECT * FROM users WHERE chat_id = ?").bind(id).first();

async function setUser(env, id, fields) {
  const keys = Object.keys(fields);
  await env.DB.prepare(
    `INSERT INTO users (chat_id, ${keys.join(", ")}) VALUES (?, ${keys.map(() => "?").join(", ")})
     ON CONFLICT(chat_id) DO UPDATE SET ${keys.map((k) => `${k} = excluded.${k}`).join(", ")},
     updated_at = CURRENT_TIMESTAMP`
  )
    .bind(id, ...keys.map((k) => fields[k]))
    .run();
}

let STREETS = null;
let STREETS_AT = 0;
async function loadStreets(env) {
  if (STREETS && Date.now() - STREETS_AT < 30 * 60 * 1000) return STREETS;
  const { results } = await env.DB.prepare("SELECT id, name FROM streets").all();
  STREETS = results.map((r) => ({ id: r.id, name: r.name, norm: norm(r.name) }));
  STREETS_AT = Date.now();
  return STREETS;
}

// Запустити позачергову перевірку на GitHub (щоб не чекати до 10 хв)
async function triggerCheck(env, reason) {
  if (!env.GH_TOKEN || !env.GH_REPO) return false;
  const r = await fetch(
    `https://api.github.com/repos/${env.GH_REPO}/actions/workflows/check.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "dtek-monitor-bot",
      },
      body: JSON.stringify({ ref: "main", inputs: { reason } }),
    }
  );
  if (r.status !== 204) console.error("GitHub dispatch:", r.status, await r.text());
  await checkTokenExpiry(env, r.headers.get("github-authentication-token-expiration"));
  return r.status === 204;
}

// GitHub повідомляє дату закінчення токена: "2026-12-13 16:15:00 +0200" або "... UTC"
export function parseGhDate(s) {
  const m = String(s || "").match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(UTC|[+-]\d{2}:?\d{2})?/);
  if (!m) return null;
  const tz = !m[3] || m[3] === "UTC" ? "Z" : m[3].replace(/^([+-]\d{2}):?(\d{2})$/, "$1:$2");
  const d = new Date(`${m[1]}T${m[2]}${tz}`);
  return isNaN(d) ? null : d;
}

// Попередити адміна за 7 днів до закінчення GH_DISPATCH_TOKEN (раз на добу)
async function checkTokenExpiry(env, header) {
  const exp = parseGhDate(header);
  if (!exp || !env.ADMIN_CHAT_ID) return;
  const days = Math.floor((exp - Date.now()) / 86400000);
  if (days > 7) return;
  const today = new Date().toISOString().slice(0, 10);
  const last = await env.DB.prepare("SELECT value FROM meta WHERE key = 'token_expiry_alert'").first();
  if (last?.value === today) return;
  await env.DB.prepare(
    "INSERT INTO meta (key, value) VALUES ('token_expiry_alert', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  )
    .bind(today)
    .run();
  const [y, mo, d] = exp.toISOString().slice(0, 10).split("-");
  await send(
    env,
    env.ADMIN_CHAT_ID,
    `⏳ <b>ДТЕК Монітор:</b> токен <code>GH_DISPATCH_TOKEN</code> закінчується <b>${d}.${mo}.${y}</b>` +
      (days > 0 ? ` (через ${days} дн.)` : " (сьогодні)") +
      ".\n\nСтворіть новий токен (Actions: Read and write), оновіть секрет у GitHub і запустіть «Розгортання бота»."
  );
}

// ---------------------------------------------------------------- dialog

async function askStreet(env, chatId, intro = "") {
  await setUser(env, chatId, { state: "awaiting_street" });
  await setHint(env, chatId, null);
  await send(env, chatId, (intro ? intro + "\n\n" : "") + ASK_STREET, {
    reply_markup: { remove_keyboard: true },
  });
}

async function chooseStreet(env, chatId, street) {
  await setUser(env, chatId, { state: "awaiting_house", street });
  await send(
    env,
    chatId,
    `Вулиця: <b>${esc(street)}</b>\n\n🏠 Тепер введіть <b>номер будинку</b> (як на сайті ДТЕК, напр. <i>7</i>, <i>12а</i>, <i>5/2</i>).`
  );
}

// «Голосіївський 7», «просп. Голосіївський, 7а», «Хрещатик буд. 5/2» -> {street, house}
export function splitHouse(text) {
  const m = String(text)
    .trim()
    .match(/^(.+?)[\s,]+(?:буд(?:инок)?\.?\s*|б\.\s*|№\s*)?(\d{1,4}(?:\s*-?\s*[а-яґєіїa-z])?(?:\s*[\/-]\s*\d{1,4}(?:\s*-?\s*[а-яґєіїa-z])?)?)\s*$/iu);
  if (!m || !/\p{L}/u.test(m[1])) return null;
  return { street: m[1].trim(), house: m[2].replace(/\s+/g, "").replace(/(\d)-(\p{L})$/u, "$1$2") };
}

// номер будинку, який людина вказала разом з вулицею (поки обирає вулицю)
async function setHint(env, chatId, house) {
  const key = `hint:${chatId}`;
  if (house == null) return env.DB.prepare("DELETE FROM meta WHERE key = ?").bind(key).run();
  return env.DB.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  )
    .bind(key, house)
    .run();
}

async function takeHint(env, chatId) {
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(`hint:${chatId}`).first();
  if (row) await setHint(env, chatId, null);
  return row?.value ?? null;
}

async function onStreetText(env, chatId, text) {
  const streets = await loadStreets(env);
  // спершу шукаємо як є (бувають вулиці з цифрами: «8 Березня»),
  // не знайшли — пробуємо відокремити номер будинку в кінці
  let found = streets.length ? searchStreets(streets, text) : { total: 0, items: [] };
  let hint = null;
  if (!found.total) {
    const split = splitHouse(text);
    if (split) {
      const again = streets.length ? searchStreets(streets, split.street) : { total: 0, items: [] };
      if (again.total || !streets.length) {
        found = again;
        hint = split.house;
        text = split.street;
      }
    }
  }
  await setHint(env, chatId, hint);
  if (!streets.length) {
    // список вулиць ще не завантажено — приймаємо як є, перевірка уточнить
    return hint ? submitHouse(env, chatId, text.trim(), hint) : chooseStreet(env, chatId, text.trim());
  }
  const { total, items } = found;
  if (!total) {
    return send(
      env,
      chatId,
      `😕 Не знайшов вулицю «${esc(text)}» у списку ДТЕК.\n\nСпробуйте ввести коротше — лише ключове слово (напр. <i>Голосіївський</i>), або іншу назву вулиці (стару чи нову).`
    );
  }
  const more = total > items.length ? `\n\nЗнайдено ${total} варіантів — якщо вашої немає, уточніть назву.` : "";
  const note = hint ? `\n🏠 Будинок <b>${esc(hint)}</b> — запам'ятав, вводити ще раз не треба.` : "";
  await send(env, chatId, `Оберіть вашу вулицю:${note}${more}`, {
    reply_markup: {
      inline_keyboard: items.map((s) => [{ text: s.name, callback_data: `st:${s.id}` }]),
    },
  });
}

async function onHouseText(env, chatId, user, text) {
  const house = text.trim();
  if (!house || house.length > 20) {
    return send(env, chatId, "Введіть, будь ласка, лише номер будинку (напр. <i>7</i> або <i>12а</i>).");
  }
  return submitHouse(env, chatId, user.street, house);
}

async function submitHouse(env, chatId, street, house) {
  await setUser(env, chatId, { state: "pending", street, house });
  const fast = await triggerCheck(env, "address");
  await send(
    env,
    chatId,
    `📍 <b>${esc(street)}, ${esc(house)}</b>\n\n⏳ Перевіряю адресу на сайті ДТЕК — це займе ${fast ? "1–2 хвилини" : "до 10 хвилин"}. Я напишу, щойно буде результат.`
  );
}

async function showStatus(env, chatId, user) {
  if (!user || user.state === "awaiting_street" || user.state === "awaiting_house") {
    return send(env, chatId, "Спершу вкажіть адресу — /address");
  }
  if (user.state === "pending") {
    return send(env, chatId, "⏳ Адреса ще перевіряється, зачекайте трохи.");
  }
  if (user.state === "stopped") {
    return send(env, chatId, "Ви відписані від сповіщень. /start — підписатися знову.");
  }
  if (!user.last_text) {
    return send(env, chatId, "Графік ще не отримано — спробуйте за кілька хвилин.", {
      reply_markup: MAIN_KEYBOARD,
    });
  }
  return send(env, chatId, user.last_text, { reply_markup: MAIN_KEYBOARD });
}

async function onMessage(env, msg) {
  if (msg.chat?.type !== "private" || typeof msg.text !== "string") return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const cmd = text.startsWith("/") ? text.split(/[\s@]/)[0].toLowerCase() : null;
  const user = await getUser(env, chatId);

  if (cmd === "/start") {
    if (user?.street && user?.house && (user.state === "active" || user.state === "stopped")) {
      await setUser(env, chatId, { state: "active" });
      return send(
        env,
        chatId,
        `${user.state === "stopped" ? "🔔 Підписку відновлено!" : "Ви вже підписані."}\n📍 ${esc(user.street)}, ${esc(user.house)}\n\n${HELP}`,
        { reply_markup: MAIN_KEYBOARD }
      );
    }
    return askStreet(env, chatId, WELCOME);
  }
  if (cmd === "/address" || text === BTN_ADDRESS) return askStreet(env, chatId);
  if (cmd === "/status" || text === BTN_SCHEDULE) return showStatus(env, chatId, user);
  if (cmd === "/stop") {
    if (user) await setUser(env, chatId, { state: "stopped" });
    return send(
      env,
      chatId,
      "🔕 Ви відписались від сповіщень.\n/start — підписатися знову.\n/delete — повністю видалити ваші дані.",
      { reply_markup: { remove_keyboard: true } }
    );
  }
  if (cmd === "/delete") {
    if (!user) return send(env, chatId, "Про вас нічого не збережено.");
    return send(
      env,
      chatId,
      "Видалити всі ваші дані — адресу, групу і збережений графік?\nСповіщення припиняться.",
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🗑 Так, видалити", callback_data: "del:yes" }],
            [{ text: "Скасувати", callback_data: "del:no" }],
          ],
        },
      }
    );
  }
  if (cmd === "/help") return send(env, chatId, HELP);

  if (!user) return askStreet(env, chatId, WELCOME);
  if (cmd) return send(env, chatId, HELP);

  switch (user.state) {
    case "awaiting_street":
      return onStreetText(env, chatId, text);
    case "awaiting_house":
      return onHouseText(env, chatId, user, text);
    case "pending":
      return send(env, chatId, "⏳ Адреса ще перевіряється, зачекайте трохи.");
    case "stopped":
      return send(env, chatId, "Ви відписані від сповіщень. /start — підписатися знову.");
    default:
      return send(env, chatId, HELP, { reply_markup: MAIN_KEYBOARD });
  }
}

async function onCallback(env, cb) {
  const chatId = cb.message?.chat?.id;
  const data = cb.data || "";
  await tg(env, "answerCallbackQuery", { callback_query_id: cb.id });
  if (!chatId) return;
  const clearButtons = () =>
    tg(env, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: cb.message.message_id,
      reply_markup: { inline_keyboard: [] },
    });

  if (data === "del:yes") {
    await env.DB.prepare("DELETE FROM users WHERE chat_id = ?").bind(chatId).run();
    await clearButtons();
    return send(env, chatId, "🗑 Ваші дані видалено.\nЯкщо захочете повернутися — /start.", {
      reply_markup: { remove_keyboard: true },
    });
  }
  if (data === "del:no") {
    await clearButtons();
    return send(env, chatId, "Гаразд, нічого не видалено.");
  }
  if (!data.startsWith("st:")) return;

  const user = await getUser(env, chatId);
  if (!user || user.state !== "awaiting_street") {
    return send(env, chatId, "Щоб змінити адресу, натисніть /address");
  }
  const row = await env.DB.prepare("SELECT name FROM streets WHERE id = ?")
    .bind(Number(data.slice(3)))
    .first();
  if (!row) return send(env, chatId, "Список вулиць оновився — введіть назву ще раз.");

  await clearButtons();
  const hint = await takeHint(env, chatId);
  return hint ? submitHouse(env, chatId, row.name, hint) : chooseStreet(env, chatId, row.name);
}

// ---------------------------------------------------------------- розклад

// Cloudflare Cron (wrangler.toml) кожні 10 хв запускає перевірку на GitHub.
// Розклад GitHub Actions ненадійний, тож запускаємо самі.
async function onSchedule(env) {
  const ok = await triggerCheck(env, "cron");
  const alerted = await env.DB.prepare("SELECT value FROM meta WHERE key = 'dispatch_alert'").first();
  if (ok && alerted) {
    await env.DB.prepare("DELETE FROM meta WHERE key = 'dispatch_alert'").run();
    if (env.ADMIN_CHAT_ID) await send(env, env.ADMIN_CHAT_ID, "✅ Перевірки графіка знову запускаються.");
  }
  if (!ok && !alerted) {
    await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('dispatch_alert', ?)")
      .bind(new Date().toISOString())
      .run();
    if (env.ADMIN_CHAT_ID) {
      await send(
        env,
        env.ADMIN_CHAT_ID,
        "⚠️ <b>ДТЕК Монітор:</b> не вдається запустити перевірку на GitHub.\n\n" +
          "Найімовірніше, закінчився термін дії <code>GH_DISPATCH_TOKEN</code> — створіть новий, " +
          "оновіть секрет і запустіть «Розгортання бота»."
      );
    }
  }
}

// ---------------------------------------------------------------- entry

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(onSchedule(env).catch((e) => console.error("schedule error:", e?.stack || e)));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/telegram") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const update = await request.json();
      const job = update.message
        ? onMessage(env, update.message)
        : update.callback_query
          ? onCallback(env, update.callback_query)
          : null;
      if (job) ctx.waitUntil(job.catch((e) => console.error("handler error:", e?.stack || e)));
      return new Response("ok");
    }
    return new Response("ДТЕК Монітор працює", { headers: { "content-type": "text/plain; charset=utf-8" } });
  },
};
