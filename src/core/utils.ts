import { OperationStatus } from "./constants";
import { normalizeToolError } from "./errors";

export function createTextResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof data === "string" ? data : "取得しました。",
      },
    ],
    structuredContent: data,
  };
}

export function createContextResult(data: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text" as const,
        text: "読み込みました。",
      },
    ],
    structuredContent: data,
  };
}

export function createStructuredResult(data: Record<string, unknown>, message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    structuredContent: data,
  };
}

export function attachToolTiming<T>(result: T, elapsedMs: number): T {
  if (!result || typeof result !== "object") {
    return result;
  }

  const record = result as Record<string, unknown>;
  const structured = record.structuredContent;
  const timing = {
    elapsed_ms: elapsedMs,
    elapsed_seconds: Number((elapsedMs / 1000).toFixed(3)),
  };

  return {
    ...record,
    structuredContent:
      structured && typeof structured === "object" && !Array.isArray(structured)
        ? { ...(structured as Record<string, unknown>), ...timing }
        : { result: structured, ...timing },
  } as T;
}

export function createWriteResult(
  action: string,
  result: Record<string, unknown>,
  operationStatus: OperationStatus = OperationStatus.Completed,
) {
  const needsFollowUp = operationStatus !== OperationStatus.Completed;
  const payload = {
    operation_status: operationStatus,
    action,
    needs_follow_up: needsFollowUp,
    result,
  };

  return {
    content: [
      {
        type: "text" as const,
        text: needsFollowUp
          ? "一部未完了です。result内の失敗またはスキップを確認してください。"
          : "処理は完了しました。追加確認は不要です。",
      },
    ],
    structuredContent: payload,
  };
}

export function createErrorResult(error: unknown) {
  const payload = {
    ok: false,
    error: normalizeToolError(error),
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true as const,
  };
}

export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

export function randomHex(byteLength: number) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
