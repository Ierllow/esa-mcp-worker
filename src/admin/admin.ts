import {
  ADMIN_SESSION_TTL_SECONDS,
  AuditEventType,
  AuditStatus,
  HttpMethod,
  HttpStatusCode,
  KV_OAUTH_PASSCODE_KEY,
  KV_SIGNING_SECRET_KEY,
  ObserverReadMode,
  SignedPayloadKind,
} from "../core/constants";
import { readContextObserverManifest, removeObservedPost, upsertObservedPost } from "../state/context-observer";
import { createSignedValue, timingSafeEqual, verifySignedValue } from "../core/crypto";
import { clearConfigCache, currentOauthPasscode, currentSigningSecret, ensureAdminPassword, ensureAdminUsername } from "../core/config";
import { readAuditEvents, readConnections, shortHash, writeAudit } from "../core/audit";
import { ADMIN_DASHBOARD_STYLES, ADMIN_LOGIN_STYLES } from "./admin-ui";
import { serverConfigError } from "../core/errors";
import { isGithubAppConfigured } from "../github/github";
import { htmlEscape, htmlResponse, readCookie, requestParams } from "../core/http";
import { nowSeconds, randomHex } from "../core/utils";
import type { AdminSessionPayload, Env } from "../core/types";

enum AdminStatusTone {
  Ok = "ok",
  Warning = "warning",
  Danger = "danger",
  Neutral = "neutral",
}

enum GithubAppConfigurationStatus {
  Configured = "configured",
  Incomplete = "incomplete",
  NotConfigured = "not_configured",
}

export async function isAdminAuthenticated(request: Request, env: Env) {
  const session = readCookie(request, "esa_mcp_admin");
  if (!session) {
    return false;
  }

  const payload = await verifySignedValue<AdminSessionPayload>(session, ensureAdminPassword(env));
  return payload?.kind === SignedPayloadKind.AdminSession && payload.exp >= nowSeconds();
}

export async function createAdminCookie(env: Env) {
  const session = await createSignedValue(
    {
      kind: SignedPayloadKind.AdminSession,
      exp: nowSeconds() + ADMIN_SESSION_TTL_SECONDS,
    } satisfies AdminSessionPayload,
    ensureAdminPassword(env),
  );

  return `esa_mcp_admin=${session}; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=${ADMIN_SESSION_TTL_SECONDS}`;
}

export function clearAdminCookie() {
  return "esa_mcp_admin=; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=0";
}

function formatAdminTimestamp(value: string) {
  return new Date(value).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
}

function renderStatus(label: string, tone: AdminStatusTone = AdminStatusTone.Neutral) {
  return `<span class="status status-${tone}"><span class="status-dot" aria-hidden="true"></span>${htmlEscape(label)}</span>`;
}

function auditStatusTone(status?: AuditStatus) {
  switch (status) {
    case AuditStatus.Success:
      return AdminStatusTone.Ok;
    case AuditStatus.Failed:
      return AdminStatusTone.Danger;
    default:
      return AdminStatusTone.Neutral;
  }
}

function githubAppBadge(status: GithubAppConfigurationStatus) {
  switch (status) {
    case GithubAppConfigurationStatus.Configured:
      return renderStatus("Configured", AdminStatusTone.Ok);
    case GithubAppConfigurationStatus.Incomplete:
      return renderStatus("Incomplete", AdminStatusTone.Warning);
    default:
      return renderStatus("Not configured", AdminStatusTone.Danger);
  }
}

export function renderAdminLogin(error?: string) {
  const errorHtml = error ? `<p class="error">${htmlEscape(error)}</p>` : "";
  return htmlResponse(`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>esa MCP Admin</title>
  <style>
    ${ADMIN_LOGIN_STYLES}
  </style>
</head>
<body>
  <main>
    <div class="login-panel">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">esa</span>
        <div>
          <div class="brand-name">esa Remote MCP</div>
          <h1>Admin console</h1>
        </div>
      </div>
      ${errorHtml}
      <form method="post" action="/admin/login">
        <label for="username">Login ID
          <input id="username" name="username" type="text" autocomplete="username" required>
        </label>
        <label for="password">Password
          <input id="password" name="password" type="password" autocomplete="current-password" required>
        </label>
        <button class="primary" type="submit">Login</button>
      </form>
    </div>
  </main>
</body>
</html>`);
}

export async function renderAdminDashboard(env: Env, message?: string, revealPasscode?: string) {
  const passcode = revealPasscode ?? (await currentOauthPasscode(env));
  const signingSecret = await currentSigningSecret(env);
  const signingHash = await shortHash(signingSecret, ensureAdminPassword(env));
  const events = await readAuditEvents(env);
  const connections = await readConnections(env);
  const observerTeamName = env.ESA_DEFAULT_TEAM?.trim() ?? "";
  const observer = observerTeamName ? await readContextObserverManifest(env, observerTeamName) : undefined;
  let githubAppStatus = GithubAppConfigurationStatus.NotConfigured;
  try {
    githubAppStatus = isGithubAppConfigured(env)
      ? GithubAppConfigurationStatus.Configured
      : GithubAppConfigurationStatus.NotConfigured;
  } catch {
    githubAppStatus = GithubAppConfigurationStatus.Incomplete;
  }
  const messageHtml = message ? `<p class="notice" role="status">${htmlEscape(message)}</p>` : "";
  const observerRows = (observer?.observed_posts ?? [])
    .map((post) => `<tr>
      <td class="mono">#${post.post_number}</td>
      <td>${htmlEscape(post.title ?? "-")}</td>
      <td class="mono">${htmlEscape(post.role ?? "-")}</td>
      <td class="mono">${htmlEscape(post.last_seen_revision_number ? String(post.last_seen_revision_number) : "-")}</td>
      <td class="nowrap">${htmlEscape(post.last_seen_updated_at ? formatAdminTimestamp(post.last_seen_updated_at) : "-")}</td>
      <td class="mono">${htmlEscape(post.recommended_read ?? "-")}</td>
      <td>${htmlEscape(post.recommended_sections?.join(", ") ?? "-")}</td>
      <td class="table-action">
        <form class="inline-form" method="post" action="/admin/context-observer/remove">
          <input type="hidden" name="team_name" value="${htmlEscape(observerTeamName)}">
          <input type="hidden" name="post_number" value="${post.post_number}">
          <button class="danger-outline compact" type="submit">Remove</button>
        </form>
      </td>
    </tr>`)
    .join("");
  const connectionRows = connections
    .map((connection) => {
      const toolCounts = Object.entries(connection.tool_counts ?? {})
        .map(([toolName, count]) => `${toolName}:${count}`)
        .join(" ");
      return `<tr>
        <td class="mono">${htmlEscape(connection.id.slice(0, 8))}</td>
        <td class="nowrap">${htmlEscape(formatAdminTimestamp(connection.connected_at))}</td>
        <td class="nowrap">${htmlEscape(connection.last_seen_at ? formatAdminTimestamp(connection.last_seen_at) : "-")}</td>
        <td class="mono">${htmlEscape(connection.client_id)}</td>
        <td class="mono">${htmlEscape(connection.esa_user_id ? String(connection.esa_user_id) : "-")}</td>
        <td>${connection.github_connected
          ? renderStatus("Connected", AdminStatusTone.Ok)
          : githubAppStatus === GithubAppConfigurationStatus.Configured
            ? renderStatus("Server App", AdminStatusTone.Ok)
            : renderStatus("Not set", AdminStatusTone.Neutral)}</td>
        <td>${htmlEscape(toolCounts || "-")}</td>
        <td class="mono">${htmlEscape(connection.ip_hash ?? "-")}</td>
      </tr>`;
    })
    .join("");
  const rows = events
    .map(
      (event) => `<tr>
        <td class="nowrap">${htmlEscape(formatAdminTimestamp(event.ts))}</td>
        <td class="mono">${htmlEscape(event.type)}</td>
        <td>${htmlEscape(event.actor ?? "-")}</td>
        <td class="mono">${htmlEscape(event.connection_id?.slice(0, 8) ?? "-")}</td>
        <td class="mono">${htmlEscape(event.client_id ?? "-")}</td>
        <td class="mono">${htmlEscape(event.tool_name ?? "-")}</td>
        <td>${renderStatus(event.status ?? "-", auditStatusTone(event.status))}</td>
        <td class="mono">${htmlEscape(event.error_source ?? "-")}</td>
        <td class="mono">${htmlEscape(event.domain_status ?? "-")}</td>
        <td class="mono">${htmlEscape(event.http_status ? String(event.http_status) : "-")}</td>
        <td class="mono nowrap">${htmlEscape(event.duration_ms !== undefined ? `${event.duration_ms} ms` : "-")}</td>
        <td>${htmlEscape(event.target ?? "-")}</td>
        <td class="mono">${htmlEscape(event.esa_user_id ? String(event.esa_user_id) : "-")}</td>
        <td class="mono">${htmlEscape(event.redirect_host ?? "-")}</td>
        <td class="mono">${htmlEscape(event.esa_token_scope ?? "-")}</td>
        <td class="mono">${htmlEscape(event.ip_hash ?? "-")}</td>
      </tr>`,
    )
    .join("");
  const githubAppStatusBadge = githubAppBadge(githubAppStatus);

  return htmlResponse(`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>esa MCP Admin</title>
  <style>
    ${ADMIN_DASHBOARD_STYLES}
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">esa</span>
        <div>
          <div class="brand-name">esa Remote MCP</div>
          <h1>Admin console</h1>
        </div>
      </div>
      <form class="inline-form" method="post" action="/admin/logout"><button class="secondary" type="submit">Logout</button></form>
    </header>
    ${messageHtml}
    <div class="summary-strip" aria-label="System overview">
      <div class="summary-item"><span class="summary-label">Connections</span><span class="summary-value">${connections.length}</span></div>
      <div class="summary-item"><span class="summary-label">Observed posts</span><span class="summary-value">${observer?.observed_posts.length ?? 0}</span></div>
      <div class="summary-item"><span class="summary-label">Recent events</span><span class="summary-value">${events.length}</span></div>
      <div class="summary-item"><span class="summary-label">GitHub App</span><span class="summary-value">${githubAppStatusBadge}</span></div>
    </div>
    <div class="section-tabs" role="tablist" aria-label="Admin sections">
      <button id="tab-access" class="tab-button" type="button" role="tab" aria-selected="true" aria-controls="access" data-tab="access">Access</button>
      <button id="tab-observer" class="tab-button" type="button" role="tab" aria-selected="false" aria-controls="observer" data-tab="observer">Context observer</button>
      <button id="tab-connections" class="tab-button" type="button" role="tab" aria-selected="false" aria-controls="connections" data-tab="connections">Connections</button>
      <button id="tab-events" class="tab-button" type="button" role="tab" aria-selected="false" aria-controls="events" data-tab="events">Access log</button>
    </div>
    <section id="access" class="tab-panel" role="tabpanel" aria-labelledby="tab-access">
      <div class="section-heading">
        <h2>Access control</h2>
      </div>
      <div class="access-grid">
        <div>
          <h3>OAuth passcode</h3>
          <div class="field-actions">
            <input id="passcode" aria-label="OAuth passcode" readonly value="${htmlEscape(passcode)}">
            <button id="copy-passcode" class="secondary" type="button">Copy</button>
          </div>
          <div class="action-row">
            <form class="inline-form" method="post" action="/admin/rotate-passcode"><button type="submit">Regenerate</button></form>
          </div>
        </div>
        <div>
          <h3>Session security</h3>
          <dl class="key-values">
            <dt>Signing key</dt><dd class="mono">${htmlEscape(signingHash)}</dd>
            <dt>GitHub App</dt><dd>${githubAppBadge}</dd>
          </dl>
          <form class="inline-form" method="post" action="/admin/revoke-sessions"><button class="danger" type="submit">Revoke all sessions</button></form>
        </div>
      </div>
    </section>
    <section id="observer" class="tab-panel" role="tabpanel" aria-labelledby="tab-observer" hidden>
      <div class="section-heading">
        <h2>Context observer</h2>
        <p class="section-meta">Cloudflare KV${observer?.updated_at ? ` / ${htmlEscape(formatAdminTimestamp(observer.updated_at))}` : ""}</p>
      </div>
      <form class="grid" method="post" action="/admin/context-observer/upsert">
        <label>Team
          <input name="team_name" value="${htmlEscape(observerTeamName)}" required>
        </label>
        <label>Post number
          <input name="post_number" type="number" min="1" required>
        </label>
        <label>Role
          <input name="role" maxlength="80">
        </label>
        <label>Read mode
          <select name="recommended_read">
            <option value="">None</option>
            ${Object.values(ObserverReadMode).map((mode) => `<option value="${mode}">${mode}</option>`).join("")}
          </select>
        </label>
        <label class="wide">Recommended sections
          <input name="recommended_sections" maxlength="4000">
        </label>
        <div class="wide form-actions"><button class="primary" type="submit">Add or update</button></div>
      </form>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Post</th><th>Title</th><th>Role</th><th>Revision</th><th>Updated</th><th>Read</th><th>Sections</th><th></th></tr></thead>
          <tbody>${observerRows || `<tr><td colspan="8" class="muted">No monitored posts</td></tr>`}</tbody>
        </table>
      </div>
    </section>
    <section id="connections" class="tab-panel" role="tabpanel" aria-labelledby="tab-connections" hidden>
      <div class="section-heading">
        <h2>Connections</h2>
        <p class="section-meta">${connections.length} recorded</p>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>Connected</th><th>Last seen</th><th>Client</th><th>esa user</th><th>GitHub</th><th>Sampled tools</th><th>IP hash</th></tr></thead>
          <tbody>${connectionRows || `<tr><td colspan="8" class="muted">No connections yet</td></tr>`}</tbody>
        </table>
      </div>
    </section>
    <section id="events" class="tab-panel" role="tabpanel" aria-labelledby="tab-events" hidden>
      <div class="section-heading">
        <h2>Recent access log</h2>
        <p class="section-meta">${events.length} retained</p>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Time</th><th>Event</th><th>Actor</th><th>Conn</th><th>Client</th><th>Tool</th><th>Status</th><th>Error source</th><th>Domain status</th><th>HTTP</th><th>Duration</th><th>Target</th><th>esa user</th><th>Callback</th><th>esa scope</th><th>IP hash</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="17" class="muted">No events yet</td></tr>`}</tbody>
        </table>
      </div>
    </section>
  </main>
  <script>
    const tabButtons = Array.from(document.querySelectorAll("[role=tab]"));
    const tabPanels = Array.from(document.querySelectorAll("[role=tabpanel]"));
    const availableTabs = new Set(tabButtons.map((button) => button.dataset.tab));

    function activateTab(tabName, moveFocus = false) {
      if (!availableTabs.has(tabName)) return;
      for (const button of tabButtons) {
        const selected = button.dataset.tab === tabName;
        button.setAttribute("aria-selected", String(selected));
        button.tabIndex = selected ? 0 : -1;
        if (selected && moveFocus) button.focus();
      }
      for (const panel of tabPanels) panel.hidden = panel.id !== tabName;
      try { sessionStorage.setItem("esa-mcp-admin-tab", tabName); } catch {}
      history.replaceState(null, "", "#" + tabName);
    }

    const requestedTab = location.hash.slice(1);
    let savedTab = "";
    try { savedTab = sessionStorage.getItem("esa-mcp-admin-tab") ?? ""; } catch {}
    activateTab(availableTabs.has(requestedTab) ? requestedTab : savedTab || "access");

    for (const [index, button] of tabButtons.entries()) {
      button.addEventListener("click", () => activateTab(button.dataset.tab ?? "access"));
      button.addEventListener("keydown", (event) => {
        let nextIndex;
        if (event.key === "ArrowRight") nextIndex = (index + 1) % tabButtons.length;
        if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabButtons.length) % tabButtons.length;
        if (event.key === "Home") nextIndex = 0;
        if (event.key === "End") nextIndex = tabButtons.length - 1;
        if (nextIndex === undefined) return;
        event.preventDefault();
        activateTab(tabButtons[nextIndex].dataset.tab ?? "access", true);
      });
    }

    const copyButton = document.getElementById("copy-passcode");
    copyButton?.addEventListener("click", async () => {
      const passcode = document.getElementById("passcode");
      if (!(passcode instanceof HTMLInputElement)) return;
      try {
        await navigator.clipboard.writeText(passcode.value);
        copyButton.textContent = "Copied";
      } catch {
        copyButton.textContent = "Copy failed";
      }
      window.setTimeout(() => { copyButton.textContent = "Copy"; }, 1400);
    });
  </script>
</body>
</html>`);
}

export function requireConfigKv(env: Env) {
  if (!env.MCP_CONFIG) {
    throw serverConfigError("MCP_CONFIG KV namespace is not configured.");
  }
  return env.MCP_CONFIG;
}

export async function adminRedirect(path: string, cookie?: string) {
  return new Response(null, {
    status: HttpStatusCode.SeeOther,
    headers: {
      Location: path,
      ...(cookie ? { "Set-Cookie": cookie } : {}),
    },
  });
}

export async function handleAdmin(request: Request, env: Env) {
  const url = new URL(request.url);
  const posted = (path: string) => url.pathname === path && request.method === HttpMethod.Post;
  const observerTarget = (params: URLSearchParams) => {
    const teamName = params.get("team_name")?.trim() || env.ESA_DEFAULT_TEAM?.trim() || "";
    const postNumber = Number(params.get("post_number"));
    if (!teamName || !Number.isInteger(postNumber) || postNumber <= 0) {
      return undefined;
    }
    return { teamName, postNumber };
  };

  if (posted("/admin/login")) {
    const params = await requestParams(request);
    const username = params.get("username") ?? "";
    const password = params.get("password") ?? "";
    const usernameOk = timingSafeEqual(username, ensureAdminUsername(env));
    const passwordOk = timingSafeEqual(password, ensureAdminPassword(env));
    if (!usernameOk || !passwordOk) {
      await writeAudit(env, request, AuditEventType.AdminLoginFailed, { actor: username || "-" });
      return renderAdminLogin("Login IDかPasswordが違います。");
    }

    await writeAudit(env, request, AuditEventType.AdminLogin, { actor: username });
    return adminRedirect("/admin", await createAdminCookie(env));
  }

  const authenticated = await isAdminAuthenticated(request, env);
  if (!authenticated) {
    return renderAdminLogin();
  }

  if (posted("/admin/logout")) {
    return adminRedirect("/admin", clearAdminCookie());
  }

  if (posted("/admin/rotate-passcode")) {
    const passcode = randomHex(16);
    await requireConfigKv(env).put(KV_OAUTH_PASSCODE_KEY, passcode);
    clearConfigCache(KV_OAUTH_PASSCODE_KEY);
    await writeAudit(env, request, AuditEventType.AdminRotatedPasscode, { actor: ensureAdminUsername(env) });
    return renderAdminDashboard(env, "OAuth passcodeを再発行しました。", passcode);
  }

  if (posted("/admin/revoke-sessions")) {
    await requireConfigKv(env).put(KV_SIGNING_SECRET_KEY, randomHex(32));
    clearConfigCache(KV_SIGNING_SECRET_KEY);
    await writeAudit(env, request, AuditEventType.AdminRevokedSessions, { actor: ensureAdminUsername(env) });
    return renderAdminDashboard(env, "既存のOAuth接続を無効化しました。利用中のMCPクライアントで再接続してください。");
  }

  if (posted("/admin/context-observer/upsert")) {
    const params = await requestParams(request);
    const target = observerTarget(params);
    const recommendedRead = params.get("recommended_read") || undefined;
    if (!target) {
      return renderAdminDashboard(env, "Teamと正しいpost numberを入力してください。");
    }
    const { teamName, postNumber } = target;
    await upsertObservedPost(env, teamName, {
      post_number: postNumber,
      role: params.get("role")?.trim().slice(0, 80) || undefined,
      recommended_read: Object.values(ObserverReadMode).includes(recommendedRead as ObserverReadMode)
        ? recommendedRead as ObserverReadMode
        : undefined,
      recommended_sections: (params.get("recommended_sections") ?? "")
        .split(",")
        .map((section) => section.trim().slice(0, 200))
        .filter(Boolean)
        .slice(0, 20),
    });
    return renderAdminDashboard(env, `#${postNumber}を監視対象へ保存しました。baselineは次のMCP refreshで確定します。`);
  }

  if (posted("/admin/context-observer/remove")) {
    const target = observerTarget(await requestParams(request));
    if (!target) {
      return renderAdminDashboard(env, "削除対象が正しくありません。");
    }
    const { teamName, postNumber } = target;
    await removeObservedPost(env, teamName, postNumber);
    return renderAdminDashboard(env, `#${postNumber}を監視対象から外しました。`);
  }

  return renderAdminDashboard(env);
}
