-- webdav_configs
CREATE TABLE IF NOT EXISTS webdav_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'webdav',
  endpoint TEXT NOT NULL,
  mount_id TEXT,
  username_enc TEXT NOT NULL,
  password_enc TEXT NOT NULL,
  quota_bytes INTEGER NOT NULL DEFAULT 10737418240,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_webdav_configs_name ON webdav_configs(name);
