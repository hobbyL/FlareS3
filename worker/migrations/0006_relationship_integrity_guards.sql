-- Future-write relationship integrity guards.
-- D1/SQLite cannot add foreign keys to existing tables without rebuilding them, so this
-- migration protects new writes while preserving existing data and cleanup flows.

CREATE TRIGGER IF NOT EXISTS trg_sessions_user_exists_insert
BEFORE INSERT ON sessions
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'sessions.user_id must reference users.id');
END;

CREATE TRIGGER IF NOT EXISTS trg_sessions_user_exists_update
BEFORE UPDATE OF user_id ON sessions
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'sessions.user_id must reference users.id');
END;

CREATE TRIGGER IF NOT EXISTS trg_files_owner_exists_insert
BEFORE INSERT ON files
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.owner_id)
BEGIN
  SELECT RAISE(ABORT, 'files.owner_id must reference users.id');
END;

CREATE TRIGGER IF NOT EXISTS trg_files_owner_exists_update
BEFORE UPDATE OF owner_id ON files
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.owner_id)
BEGIN
  SELECT RAISE(ABORT, 'files.owner_id must reference users.id');
END;

CREATE TRIGGER IF NOT EXISTS trg_files_config_exists_insert
BEFORE INSERT ON files
WHEN NEW.config_id IS NOT NULL
  AND TRIM(NEW.config_id) <> ''
  AND NOT EXISTS (SELECT 1 FROM r2_configs WHERE id = NEW.config_id)
  AND NOT EXISTS (SELECT 1 FROM webdav_configs WHERE id = NEW.config_id)
BEGIN
  SELECT RAISE(ABORT, 'files.config_id must reference a storage config');
END;

CREATE TRIGGER IF NOT EXISTS trg_files_config_exists_update
BEFORE UPDATE OF config_id ON files
WHEN NEW.config_id IS NOT NULL
  AND TRIM(NEW.config_id) <> ''
  AND NOT EXISTS (SELECT 1 FROM r2_configs WHERE id = NEW.config_id)
  AND NOT EXISTS (SELECT 1 FROM webdav_configs WHERE id = NEW.config_id)
BEGIN
  SELECT RAISE(ABORT, 'files.config_id must reference a storage config');
END;

CREATE TRIGGER IF NOT EXISTS trg_texts_owner_exists_insert
BEFORE INSERT ON texts
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.owner_id)
BEGIN
  SELECT RAISE(ABORT, 'texts.owner_id must reference users.id');
END;

CREATE TRIGGER IF NOT EXISTS trg_texts_owner_exists_update
BEFORE UPDATE OF owner_id ON texts
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.owner_id)
BEGIN
  SELECT RAISE(ABORT, 'texts.owner_id must reference users.id');
END;

CREATE TRIGGER IF NOT EXISTS trg_file_shares_file_owner_insert
BEFORE INSERT ON file_shares
WHEN NOT EXISTS (
  SELECT 1 FROM files WHERE id = NEW.file_id AND owner_id = NEW.owner_id
)
BEGIN
  SELECT RAISE(ABORT, 'file_shares must reference an existing file owned by owner_id');
END;

CREATE TRIGGER IF NOT EXISTS trg_file_shares_file_owner_update
BEFORE UPDATE OF file_id, owner_id ON file_shares
WHEN NOT EXISTS (
  SELECT 1 FROM files WHERE id = NEW.file_id AND owner_id = NEW.owner_id
)
BEGIN
  SELECT RAISE(ABORT, 'file_shares must reference an existing file owned by owner_id');
END;

CREATE TRIGGER IF NOT EXISTS trg_text_shares_text_owner_insert
BEFORE INSERT ON text_shares
WHEN NOT EXISTS (
  SELECT 1 FROM texts WHERE id = NEW.text_id AND owner_id = NEW.owner_id
)
BEGIN
  SELECT RAISE(ABORT, 'text_shares must reference an existing text owned by owner_id');
END;

CREATE TRIGGER IF NOT EXISTS trg_text_shares_text_owner_update
BEFORE UPDATE OF text_id, owner_id ON text_shares
WHEN NOT EXISTS (
  SELECT 1 FROM texts WHERE id = NEW.text_id AND owner_id = NEW.owner_id
)
BEGIN
  SELECT RAISE(ABORT, 'text_shares must reference an existing text owned by owner_id');
END;

CREATE TRIGGER IF NOT EXISTS trg_text_one_time_shares_text_owner_insert
BEFORE INSERT ON text_one_time_shares
WHEN NOT EXISTS (
  SELECT 1 FROM texts WHERE id = NEW.text_id AND owner_id = NEW.owner_id
)
BEGIN
  SELECT RAISE(ABORT, 'text_one_time_shares must reference an existing text owned by owner_id');
END;

CREATE TRIGGER IF NOT EXISTS trg_text_one_time_shares_text_owner_update
BEFORE UPDATE OF text_id, owner_id ON text_one_time_shares
WHEN NOT EXISTS (
  SELECT 1 FROM texts WHERE id = NEW.text_id AND owner_id = NEW.owner_id
)
BEGIN
  SELECT RAISE(ABORT, 'text_one_time_shares must reference an existing text owned by owner_id');
END;

CREATE TRIGGER IF NOT EXISTS trg_delete_queue_file_exists_insert
BEFORE INSERT ON delete_queue
WHEN NOT EXISTS (SELECT 1 FROM files WHERE id = NEW.file_id)
BEGIN
  SELECT RAISE(ABORT, 'delete_queue.file_id must reference files.id');
END;

CREATE TRIGGER IF NOT EXISTS trg_delete_queue_file_exists_update
BEFORE UPDATE OF file_id ON delete_queue
WHEN NOT EXISTS (SELECT 1 FROM files WHERE id = NEW.file_id)
BEGIN
  SELECT RAISE(ABORT, 'delete_queue.file_id must reference files.id');
END;

CREATE TRIGGER IF NOT EXISTS trg_upload_reservations_user_config_insert
BEFORE INSERT ON upload_reservations
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id)
  OR (
    NOT EXISTS (SELECT 1 FROM r2_configs WHERE id = NEW.r2_config_id)
    AND NOT EXISTS (SELECT 1 FROM webdav_configs WHERE id = NEW.r2_config_id)
  )
BEGIN
  SELECT RAISE(ABORT, 'upload_reservations must reference an existing user and storage config');
END;

CREATE TRIGGER IF NOT EXISTS trg_upload_reservations_user_config_update
BEFORE UPDATE OF user_id, r2_config_id ON upload_reservations
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id)
  OR (
    NOT EXISTS (SELECT 1 FROM r2_configs WHERE id = NEW.r2_config_id)
    AND NOT EXISTS (SELECT 1 FROM webdav_configs WHERE id = NEW.r2_config_id)
  )
BEGIN
  SELECT RAISE(ABORT, 'upload_reservations must reference an existing user and storage config');
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_actor_exists_insert
BEFORE INSERT ON audit_logs
WHEN NEW.actor_user_id IS NOT NULL
  AND TRIM(NEW.actor_user_id) <> ''
  AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.actor_user_id)
BEGIN
  SELECT RAISE(ABORT, 'audit_logs.actor_user_id must reference users.id when present');
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_actor_exists_update
BEFORE UPDATE OF actor_user_id ON audit_logs
WHEN NEW.actor_user_id IS NOT NULL
  AND TRIM(NEW.actor_user_id) <> ''
  AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.actor_user_id)
BEGIN
  SELECT RAISE(ABORT, 'audit_logs.actor_user_id must reference users.id when present');
END;
