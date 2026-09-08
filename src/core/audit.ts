import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUDIT_PREFIX,
  CONNECTION_PREFIX,
  AuditEventType,
  AuditLevel,
  AuditStatus,
} from "./constants";
import { bytesToBase64Url } from "./crypto";
import type { AccessTokenPayload, AuditEvent, ConnectionRecord, Env } from "./types";
import { normalizeToolError } from "./errors";
import { attachToolTiming, createErrorResult } from "./utils";

const DEFAULT_CONNECTION_WRITE_INTERVAL_SECONDS = 15 * 60;
const DEFAULT_SLOW_TOOL_THRESHOLD_MS = 1_000;
const CONNECTION_WRITE_CACHE_MAX_ENTRIES = 1_000;
const recentConnectionWrites = new Map<string, number>();

function auditLevel(env: Env): AuditLevel {
  const value = env.MCP_AUDIT_LEVEL?.toLowerCase();
  if (Object.values(AuditLevel).includes(value as AuditLevel)) {
    return value as AuditLevel;
  }
  return AuditLevel.Minimal;
}

function slowToolThresholdMs(env: Env) {
  const parsed = Number(env.MCP_SLOW_TOOL_THRESHOLD_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SLOW_TOOL_THRESHOLD_MS;
}

export function shouldWriteAudit(env: Env, type: AuditEventType, details: Partial<AuditEvent>) {
  const level = auditLevel(env);
  if (level === AuditLevel.None) {
    return false;
  }
  if (level === AuditLevel.All) {
    return true;
  }
  return (
    type !== AuditEventType.ToolCall ||
    details.status === AuditStatus.Failed ||
    (details.status === AuditStatus.Success && (details.duration_ms ?? 0) >= slowToolThresholdMs(env))
  );
}

function rememberConnectionWrite(connectionId: string, timestamp: number) {
  recentConnectionWrites.delete(connectionId);
  recentConnectionWrites.set(connectionId, timestamp);
  if (recentConnectionWrites.size > CONNECTION_WRITE_CACHE_MAX_ENTRIES) {
    const oldestConnectionId = recentConnectionWrites.keys().next().value;
    if (oldestConnectionId) {
      recentConnectionWrites.delete(oldestConnectionId);
    }
  }
}

function connectionWriteIntervalSeconds(env: Env) {
  const raw = env.MCP_CONNECTION_WRITE_INTERVAL_SECONDS;
  if (!raw) {
    return DEFAULT_CONNECTION_WRITE_INTERVAL_SECONDS;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_CONNECTION_WRITE_INTERVAL_SECONDS;
  }
  return Math.floor(parsed);
}

const CONNECTION_TTL_SECONDS = ACCESS_TOKEN_TTL_SECONDS + 7 * 24 * 60 * 60;
const AUDIT_TTL_SECONDS = 90 * 24 * 60 * 60;

function clientIp(request: Request) {
  return request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Forwarded-For") ?? "";
}

function clientUserAgent(request: Request) {
  return request.headers.get("User-Agent")?.slice(0, 160);
}

function auditSecret(env: Env) {
  return env.MCP_ADMIN_PASSWORD ?? env.MCP_BEARER_TOKEN ?? "audit";
}

async function putRecord(kv: KVNamespace, key: string, value: unknown, expirationTtl: number, label: string) {
  try {
    await kv.put(key, JSON.stringify(value), { expirationTtl });
    return true;
  } catch (error) {
    console.warn(`${label} skipped`, error);
    return false;
  }
}

async function ignoreTrackingError(label: string, task: Promise<unknown>) {
  try {
    await task;
  } catch (error) {
    console.warn(`${label} skipped`, error instanceof Error ? error.name : typeof error);
  }
}

async function runTracking(ctx: ExecutionContext | undefined, label: string, task: Promise<unknown>) {
  const handledTask = ignoreTrackingError(label, task);
  if (ctx) {
    ctx.waitUntil(handledTask);
    return;
  }
  await handledTask;
}

export async function shortHash(value: string, secret: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${secret}:${value}`));
  return bytesToBase64Url(new Uint8Array(hash)).slice(0, 12);
}

export async function writeAudit(env: Env, request: Request, type: AuditEventType, details: Partial<AuditEvent> = {}) {
  if (!env.MCP_CONFIG || !shouldWriteAudit(env, type, details)) {
    return;
  }

  const ip = clientIp(request);
  const secret = auditSecret(env);
  const invertedTimestamp = String(9999999999999 - Date.now()).padStart(13, "0");
  const event: AuditEvent = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    type,
    ip_hash: ip ? await shortHash(ip, secret) : undefined,
    user_agent: clientUserAgent(request),
    ...details,
  };

  await putRecord(env.MCP_CONFIG, `${AUDIT_PREFIX}${invertedTimestamp}:${event.id}`, event, AUDIT_TTL_SECONDS, "audit write");
}

export function safeHost(value: string) {
  try {
    return new URL(value).host;
  } catch {
    return undefined;
  }
}

export function normalizeScope(scope: string[] | string | undefined) {
  if (Array.isArray(scope)) {
    return scope;
  }
  if (typeof scope === "string") {
    return scope.split(/\s+/).filter(Boolean);
  }
  return undefined;
}

export async function readAuditEvents(env: Env, limit = 30): Promise<AuditEvent[]> {
  if (!env.MCP_CONFIG) {
    return [];
  }

  const listed = await env.MCP_CONFIG.list({ prefix: AUDIT_PREFIX, limit });
  const events = await Promise.all(listed.keys.map((key) => env.MCP_CONFIG!.get<AuditEvent>(key.name, "json")));
  return events.filter((event): event is AuditEvent => Boolean(event));
}

export async function connectionIpHash(env: Env, request: Request) {
  const ip = request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Forwarded-For") ?? "";
  const secret = env.MCP_ADMIN_PASSWORD ?? env.MCP_BEARER_TOKEN ?? "audit";
  return ip ? shortHash(ip, secret) : undefined;
}

export async function writeConnection(env: Env, request: Request, record: Omit<ConnectionRecord, "ip_hash" | "user_agent">) {
  if (!env.MCP_CONFIG) {
    return;
  }

  const fullRecord: ConnectionRecord = {
    ...record,
    ip_hash: await connectionIpHash(env, request),
    user_agent: clientUserAgent(request),
    tool_counts: {},
  };
  if (await putRecord(env.MCP_CONFIG, `${CONNECTION_PREFIX}${record.id}`, fullRecord, CONNECTION_TTL_SECONDS, "connection write")) {
    rememberConnectionWrite(record.id, Date.now());
  }
}

export async function updateConnectionUsage(env: Env, connectionId: string | undefined, toolName?: string) {
  if (!env.MCP_CONFIG || !connectionId) {
    return;
  }

  const key = `${CONNECTION_PREFIX}${connectionId}`;
  const now = Date.now();
  const intervalSeconds = connectionWriteIntervalSeconds(env);
  const recentWrite = recentConnectionWrites.get(connectionId);
  if (intervalSeconds > 0 && recentWrite && now - recentWrite < intervalSeconds * 1000) {
    return;
  }

  const record = await env.MCP_CONFIG.get<ConnectionRecord>(key, "json").catch((error) => {
    console.warn("connection read skipped", error);
    return undefined;
  });
  if (!record) {
    return;
  }

  const lastSeenAt = record.last_seen_at ? Date.parse(record.last_seen_at) : 0;
  const shouldWrite = intervalSeconds === 0 || !lastSeenAt || now - lastSeenAt >= intervalSeconds * 1000;
  if (!shouldWrite) {
    rememberConnectionWrite(connectionId, lastSeenAt);
    return;
  }

  record.last_seen_at = new Date(now).toISOString();
  if (toolName) {
    record.tool_counts = record.tool_counts ?? {};
    record.tool_counts[toolName] = (record.tool_counts[toolName] ?? 0) + 1;
  }

  if (await putRecord(env.MCP_CONFIG, key, record, CONNECTION_TTL_SECONDS, "connection usage write")) {
    rememberConnectionWrite(connectionId, now);
  }
}

export async function readConnections(env: Env, limit = 30): Promise<ConnectionRecord[]> {
  if (!env.MCP_CONFIG) {
    return [];
  }

  const listed = await env.MCP_CONFIG.list({ prefix: CONNECTION_PREFIX, limit });
  const connections = await Promise.all(listed.keys.map((key) => env.MCP_CONFIG!.get<ConnectionRecord>(key.name, "json")));
  return connections
    .filter((connection): connection is ConnectionRecord => Boolean(connection))
    .sort((a, b) => b.connected_at.localeCompare(a.connected_at));
}

export async function withToolTracking<T>(
  env: Env,
  request: Request,
  payload: AccessTokenPayload | undefined,
  ctx: ExecutionContext | undefined,
  toolName: string,
  details: Partial<AuditEvent> = {},
  run: () => Promise<T>,
) {
  const startedAt = Date.now();
  const connectionId = payload?.connection_id;
  try {
    const result = await run();
    const durationMs = Date.now() - startedAt;
    await runTracking(
      ctx,
      "tool tracking",
      Promise.all([
        updateConnectionUsage(env, connectionId, toolName),
        writeAudit(env, request, AuditEventType.ToolCall, {
          connection_id: connectionId,
          client_id: payload?.client_id,
          esa_user_id: payload?.esa_user_id,
          tool_name: toolName,
          status: AuditStatus.Success,
          duration_ms: durationMs,
          ...details,
        }),
      ]),
    );
    return attachToolTiming(result, durationMs);
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const toolError = normalizeToolError(error);
    await runTracking(
      ctx,
      "tool error audit",
      writeAudit(env, request, AuditEventType.ToolCall, {
        connection_id: connectionId,
        client_id: payload?.client_id,
        esa_user_id: payload?.esa_user_id,
        tool_name: toolName,
        status: AuditStatus.Failed,
        duration_ms: durationMs,
        error_source: toolError.source,
        domain_status: toolError.domain_status,
        error_message: toolError.message.slice(0, 160),
        http_status: toolError.http_status,
        ...details,
      }),
    );
    return attachToolTiming(createErrorResult(error), durationMs);
  }
}
