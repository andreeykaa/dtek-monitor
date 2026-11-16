-- Користувачі бота (одна людина — одна адреса)
CREATE TABLE IF NOT EXISTS users (
  chat_id    INTEGER PRIMARY KEY,
  name       TEXT,            -- не використовується (імена не зберігаються)
  -- awaiting_street | awaiting_house | pending | active | stopped
  state      TEXT NOT NULL DEFAULT 'awaiting_street',
  street     TEXT,
  house      TEXT,
  grp        TEXT,            -- група ГПВ, напр. GPV33.1
  last_days  TEXT,            -- JSON останнього графіка (для порівняння)
  last_text  TEXT,            -- готове повідомлення з графіком (для кнопки «Графік»)
  warn       INTEGER,         -- попередження за 30 хв: NULL — ще не пропонували, 0 — вимк., 1 — увімк.
  warned     TEXT,            -- час останнього перемикання, про яке вже попередили
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Список вулиць з сайту ДТЕК (оновлює перевірка на GitHub)
CREATE TABLE IF NOT EXISTS streets (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
