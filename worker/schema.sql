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

-- Тихе спостереження за екстреними/аварійними відключеннями (етап 1, без повідомлень людям).
-- Поточний стан полів ДТЕК для будинків користувачів:
CREATE TABLE IF NOT EXISTS outage_state (
  street TEXT NOT NULL,
  house  TEXT NOT NULL,
  sig    TEXT NOT NULL,           -- type|sub_type|start_date|end_date
  since  TEXT NOT NULL,           -- коли цей стан уперше побачили (Київ)
  PRIMARY KEY (street, house)
);
-- Журнал змін (запис лише коли стан змінився). street='*' — текст банера «Шановні клієнти!»
CREATE TABLE IF NOT EXISTS outage_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,       -- час перевірки (Київ)
  street     TEXT NOT NULL,
  house      TEXT NOT NULL,
  type       TEXT,
  sub_type   TEXT,
  start_date TEXT,
  end_date   TEXT,
  dtek_upd   TEXT                 -- updateTimestamp з відповіді ДТЕК
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
