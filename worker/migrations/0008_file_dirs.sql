-- Library-mode empty directory registry.
-- 目录视图默认完全派生自 files.r2_key；本表仅登记「空目录」（无文件时也能展示/新建），
-- dir 以归一化、无尾斜杠形态存储（镜像 utils/r2Dir 的 extractDirFromR2Key 口径）。根目录永不入表。

CREATE TABLE IF NOT EXISTS file_dirs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  dir TEXT NOT NULL,               -- 归一化目录，无尾斜杠，如 docs/2024
  created_at DATETIME NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_file_dirs_owner_dir ON file_dirs(owner_id, dir);
CREATE INDEX IF NOT EXISTS idx_file_dirs_owner_id ON file_dirs(owner_id);

-- Future-write relationship integrity guards（对齐 0007 模式）：
-- D1/SQLite 无法对既有表补外键，file_dirs 的 owner 存在性用 trigger 护栏保护新写入。

CREATE TRIGGER IF NOT EXISTS trg_file_dirs_owner_exists_insert
BEFORE INSERT ON file_dirs
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.owner_id)
BEGIN
  SELECT RAISE(ABORT, 'file_dirs.owner_id must reference users.id');
END;

CREATE TRIGGER IF NOT EXISTS trg_file_dirs_owner_exists_update
BEFORE UPDATE OF owner_id ON file_dirs
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.owner_id)
BEGIN
  SELECT RAISE(ABORT, 'file_dirs.owner_id must reference users.id');
END;
