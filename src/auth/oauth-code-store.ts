export async function consumeOAuthAuthorizationCode(
  database: D1Database,
  codeId: string,
  expiresAt: number,
) {
  const now = Math.floor(Date.now() / 1000);
  if (expiresAt < now) {
    return false;
  }

  const results = await database.batch([
    database.prepare("DELETE FROM oauth_authorization_codes WHERE expires_at < ?").bind(now),
    database.prepare(`
      INSERT INTO oauth_authorization_codes (code_id, expires_at, consumed_at)
      VALUES (?, ?, ?)
      ON CONFLICT(code_id) DO NOTHING
    `).bind(codeId, expiresAt, now),
  ]);
  return results[1]?.meta.changes === 1;
}
