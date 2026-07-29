-- Apex Branding contact form submissions
-- D1 (SQLite). All writes from the /api/contact Pages Function use bound parameters.

CREATE TABLE IF NOT EXISTS submissions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name    TEXT    NOT NULL,
  last_name     TEXT    NOT NULL,
  email         TEXT    NOT NULL,
  phone         TEXT,
  website       TEXT,
  interests     TEXT,              -- JSON array: ["Rebrand/Brand Development", ...]
  outsourcing   TEXT,              -- "Yes" | "No"
  budget        TEXT,
  message       TEXT    NOT NULL,
  follow_up_ok  INTEGER DEFAULT 0, -- 0/1
  ip_address    TEXT,
  user_agent    TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  status        TEXT    NOT NULL DEFAULT 'new'  -- new | read | archived (for Command Center)
);

CREATE INDEX IF NOT EXISTS idx_submissions_created_at ON submissions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_submissions_status     ON submissions (status);
