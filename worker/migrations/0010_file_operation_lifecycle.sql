-- 物理删除一旦开始不再允许恢复；租约只允许清理重试，不能解除删除意图。
ALTER TABLE files ADD COLUMN deletion_started_at DATETIME;
ALTER TABLE files ADD COLUMN deletion_token TEXT;
ALTER TABLE files ADD COLUMN deletion_lease_until DATETIME;
-- 直传临时对象与上传活动期限独立于内容保留期。
ALTER TABLE files ADD COLUMN upload_key TEXT;
ALTER TABLE files ADD COLUMN upload_updated_at DATETIME;
ALTER TABLE files ADD COLUMN upload_etag TEXT;
-- 升级前的直传 URL 指向最终 key；先等既有一小时凭据失效，再允许清理。
UPDATE files SET upload_key = r2_key
WHERE upload_status = 'pending' AND r2_key LIKE 'flares3/%';
UPDATE files SET upload_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE upload_status IN ('pending', 'uploading');
ALTER TABLE delete_queue ADD COLUMN config_id TEXT;
ALTER TABLE delete_queue ADD COLUMN multipart_upload_id TEXT;
ALTER TABLE delete_queue ADD COLUMN upload_key TEXT;
ALTER TABLE delete_queue ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE delete_queue ADD COLUMN next_attempt_at DATETIME;
-- init 回程时文件已被清理的分片，只 abort upload ID，不删除可能已复用的对象 key。
ALTER TABLE delete_queue ADD COLUMN orphan_multipart INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_delete_queue_retry ON delete_queue(processed_at, next_attempt_at, created_at);

-- 常规任务仍引用文件；迟到的 init 补偿只引用不可复用的分片 upload ID。
DROP TRIGGER trg_delete_queue_file_exists_insert;
CREATE TRIGGER trg_delete_queue_file_exists_insert
BEFORE INSERT ON delete_queue
WHEN NEW.orphan_multipart = 0 AND NOT EXISTS (SELECT 1 FROM files WHERE id = NEW.file_id)
BEGIN
  SELECT RAISE(ABORT, 'delete_queue.file_id must reference files.id');
END;

CREATE TRIGGER trg_last_active_admin_update
BEFORE UPDATE OF role, status ON users
WHEN OLD.role = 'admin' AND OLD.status = 'active'
  AND (NEW.role <> 'admin' OR NEW.status <> 'active')
  AND NOT EXISTS (SELECT 1 FROM users WHERE id <> OLD.id AND role = 'admin' AND status = 'active')
BEGIN
  SELECT RAISE(ABORT, 'last_active_admin');
END;

-- 直删路径领取成功即持久化清理任务：进程中断或远端成功而落库失败均可收敛。
CREATE TRIGGER trg_file_deletion_claim_enqueue
AFTER UPDATE OF deletion_token ON files
WHEN NEW.deletion_token IS NOT NULL AND NEW.deletion_started_at IS NOT NULL
BEGIN
  INSERT INTO delete_queue (id, file_id, r2_key, created_at, config_id, multipart_upload_id, upload_key)
  SELECT NEW.deletion_token, NEW.id, NEW.r2_key, NEW.deletion_started_at,
         NEW.config_id, NEW.multipart_upload_id, NEW.upload_key
  WHERE NOT EXISTS (SELECT 1 FROM delete_queue WHERE file_id = NEW.id AND processed_at IS NULL AND orphan_multipart = 0);
END;

-- 未完成上传删除后不可恢复；分片 ID 与临时 key 在 files 清空前保存到任务。
CREATE TRIGGER trg_unfinished_upload_deleted
AFTER UPDATE OF upload_status ON files
WHEN NEW.upload_status = 'deleted' AND OLD.upload_status IN ('pending','uploading')
BEGIN
  UPDATE files SET deletion_started_at = COALESCE(deletion_started_at, NEW.deleted_at) WHERE id = NEW.id;
  INSERT INTO delete_queue (id, file_id, r2_key, created_at, config_id, multipart_upload_id, upload_key)
  SELECT lower(hex(randomblob(16))), NEW.id, NEW.r2_key, NEW.deleted_at,
         NEW.config_id, COALESCE(NEW.multipart_upload_id, OLD.multipart_upload_id), NEW.upload_key
  WHERE NOT EXISTS (SELECT 1 FROM delete_queue WHERE file_id = NEW.id AND processed_at IS NULL AND orphan_multipart = 0);
END;
