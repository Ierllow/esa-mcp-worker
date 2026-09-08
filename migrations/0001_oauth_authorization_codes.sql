CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  code_id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS oauth_authorization_codes_expires_at
  ON oauth_authorization_codes (expires_at);
