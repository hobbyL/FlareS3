-- Folder shares + share access logs.

CREATE TABLE IF NOT EXISTS folder_shares (
  id TEXT PRIMARY KEY,
  config_id TEXT NOT NULL,
  prefix TEXT NOT NULL,            -- 规范化尾斜杠前缀，如 docs/
  owner_id TEXT NOT NULL,
  share_code TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  expires_in INTEGER NOT NULL DEFAULT 0,
  expires_at DATETIME,
  max_views INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_folder_shares_scope ON folder_shares(config_id, prefix);
CREATE UNIQUE INDEX IF NOT EXISTS idx_folder_shares_share_code ON folder_shares(share_code);
CREATE INDEX IF NOT EXISTS idx_folder_shares_owner_id ON folder_shares(owner_id);

CREATE TABLE IF NOT EXISTS share_access_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  share_type TEXT NOT NULL,        -- file | text | folder
  share_id TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  path TEXT,                       -- folder 分享的子路径（可空）
  result TEXT NOT NULL,            -- ok | rejected_password | expired | exhausted | not_found
  created_at DATETIME NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_share_access_logs_share ON share_access_logs(share_type, share_id, id DESC);

-- Future-write relationship integrity guards（对齐 0006 模式）：
-- D1/SQLite 无法对既有表补外键，folder_shares 的 owner 存在性用 trigger 护栏保护新写入。

CREATE TRIGGER IF NOT EXISTS trg_folder_shares_owner_exists_insert
BEFORE INSERT ON folder_shares
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.owner_id)
BEGIN
  SELECT RAISE(ABORT, 'folder_shares.owner_id must reference users.id');
END;

CREATE TRIGGER IF NOT EXISTS trg_folder_shares_owner_exists_update
BEFORE UPDATE OF owner_id ON folder_shares
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.owner_id)
BEGIN
  SELECT RAISE(ABORT, 'folder_shares.owner_id must reference users.id');
END;
