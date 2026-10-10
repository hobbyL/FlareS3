-- Personal Access Tokens (API PAT) registry.
-- 个人访问令牌：明文仅在创建响应出现一次，库内只存 SHA-256 token_hash（与会话 token 同口径）。
-- 令牌不占 sessions 表、不受「下线其他设备」影响，可单独吊销（revoked_at）/ 过期（expires_at）。

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,         -- SHA-256(hex)，禁止回读明文
  created_at DATETIME NOT NULL,
  last_used_at DATETIME,            -- 节流更新（>60s 才写），best-effort 遥测
  expires_at DATETIME,              -- NULL=永不过期
  revoked_at DATETIME               -- NULL=有效；非空=已吊销
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_tokens_token_hash ON api_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user_id ON api_tokens(user_id);

-- Future-write relationship integrity guards（对齐 0007/0008 模式）：
-- D1/SQLite 无法对既有表补外键，api_tokens 的 user 存在性用 trigger 护栏保护新写入。

CREATE TRIGGER IF NOT EXISTS trg_api_tokens_user_exists_insert
BEFORE INSERT ON api_tokens
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'api_tokens.user_id must reference users.id');
END;

CREATE TRIGGER IF NOT EXISTS trg_api_tokens_user_exists_update
BEFORE UPDATE OF user_id ON api_tokens
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'api_tokens.user_id must reference users.id');
END;
