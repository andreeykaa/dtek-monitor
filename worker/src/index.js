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
  "📍 Введіть назву <b>вулиці</b> українською — можна без «вул.» чи «просп.».\n" +
  "Наприклад: <i>Голосіївський</i> або <i>Хрещатик</i>.\n\n" +
  "Я запропоную точні варіанти з сайту ДТЕК.";

const HELP =
  "Що я вмію:\n" +
  `• <b>${BTN_SCHEDULE}</b> або /status — поточний графік\n` +
  `• <b>${BTN_ADDRESS}</b> або /address — вказати іншу адресу\n` +
  "• /stop — відписатися від сповіщень";

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
async function triggerCheck(env) {
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
      body: JSON.stringify({ ref: "main" }),
    }
  );
  if (r.status !== 204) console.error("GitHub dispatch:", r.status, await r.text());
  return r.status === 204;
}

// ---------------------------------------------------------------- dialog

async function askStreet(env, chatId, name, intro = "") {
  await setUser(env, chatId, { name, state: "awaiting_street" });
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

async function onStreetText(env, chatId, text) {
  const streets = await loadStreets(env);
  if (!streets.length) {
    // список вулиць ще не завантажено — приймаємо як є, перевірка уточнить
    return chooseStreet(env, chatId, text.trim());
  }
  const { total, items } = searchStreets(streets, text);
  if (!total) {
    return send(
      env,
      chatId,
      `😕 Не знайшов вулицю «${esc(text)}» у списку ДТЕК.\n\nСпробуйте ввести коротше — лише ключове слово (напр. <i>Голосіївський</i>), або іншу назву вулиці (стару чи нову).`
    );
  }
  const more = total > items.length ? `\n\nЗнайдено ${total} варіантів — якщо вашої немає, уточніть назву.` : "";
  await send(env, chatId, `Оберіть вашу вулицю:${more}`, {
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
  await setUser(env, chatId, { state: "pending", house });
  const fast = await triggerCheck(env);
  await send(
    env,
    chatId,
    `📍 <b>${esc(user.street)}, ${esc(house)}</b>\n\n⏳ Перевіряю адресу на сайті ДТЕК — це займе ${fast ? "1–2 хвилини" : "до 10 хвилин"}. Я напишу, щойно буде результат.`
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
  const name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || null;
  const text = msg.text.trim();
  const cmd = text.startsWith("/") ? text.split(/[\s@]/)[0].toLowerCase() : null;
  const user = await getUser(env, chatId);

  if (cmd === "/start") {
    if (user?.street && user?.house && (user.state === "active" || user.state === "stopped")) {
      await setUser(env, chatId, { name, state: "active" });
      return send(
        env,
        chatId,
        `${user.state === "stopped" ? "🔔 Підписку відновлено!" : "Ви вже підписані."}\n📍 ${esc(user.street)}, ${esc(user.house)}\n\n${HELP}`,
        { reply_markup: MAIN_KEYBOARD }
      );
    }
    return askStreet(env, chatId, name, WELCOME);
  }
  if (cmd === "/address" || text === BTN_ADDRESS) return askStreet(env, chatId, name);
  if (cmd === "/status" || text === BTN_SCHEDULE) return showStatus(env, chatId, user);
  if (cmd === "/stop") {
    if (user) await setUser(env, chatId, { state: "stopped" });
    return send(env, chatId, "🔕 Ви відписались від сповіщень.\n/start — підписатися знову.", {
      reply_markup: { remove_keyboard: true },
    });
  }
  if (cmd === "/help") return send(env, chatId, HELP);

  if (!user) return askStreet(env, chatId, name, WELCOME);
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
  if (!chatId || !data.startsWith("st:")) return;

  const user = await getUser(env, chatId);
  if (!user || user.state !== "awaiting_street") {
    return send(env, chatId, "Щоб змінити адресу, натисніть /address");
  }
  const row = await env.DB.prepare("SELECT name FROM streets WHERE id = ?")
    .bind(Number(data.slice(3)))
    .first();
  if (!row) return send(env, chatId, "Список вулиць оновився — введіть назву ще раз.");

  await tg(env, "editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: cb.message.message_id,
    reply_markup: { inline_keyboard: [] },
  });
  return chooseStreet(env, chatId, row.name);
}

// ---------------------------------------------------------------- entry

export default {
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
