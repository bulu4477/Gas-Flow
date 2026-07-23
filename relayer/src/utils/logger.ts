import { AsyncLocalStorage } from "node:async_hooks";

export type LogLevel = "debug" | "info" | "warn" | "error";

interface LogMethod {
  (message: string, meta?: Record<string, unknown>): void;
}

interface Logger {
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
}

export interface RequestLogContext {
  requestId: string;
  method?: string;
  path?: string;
  clientIp?: string;
}

const requestContext = new AsyncLocalStorage<RequestLogContext>();

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const configuredLevel = normalizeLevel(process.env.LOG_LEVEL) ?? "info";

function normalizeLevel(value: string | undefined): LogLevel | undefined {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  return undefined;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[configuredLevel];
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized.includes("privatekey") ||
    normalized.includes("private_key") ||
    normalized.includes("apikey") ||
    normalized.includes("api_key") ||
    normalized.includes("authorization") ||
    normalized.includes("signature") ||
    normalized === "r" ||
    normalized === "s"
  );
}

function shouldTruncateKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized.includes("calldata") ||
    normalized.includes("rawrevertdata") ||
    normalized === "data"
  );
}

function truncate(value: string): string {
  if (value.length <= 160) return value;
  return `${value.slice(0, 120)}...[${value.length} chars]`;
}

function sanitize(value: unknown, key = "", depth = 0): unknown {
  if (value === undefined) return undefined;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    if (isSensitiveKey(key)) return "[REDACTED]";
    return shouldTruncateKey(key) ? truncate(value) : value;
  }
  if (typeof value !== "object" || value === null) return value;
  if (depth >= 4) return "[TRUNCATED]";

  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, key, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    result[childKey] = isSensitiveKey(childKey)
      ? "[REDACTED]"
      : sanitize(childValue, childKey, depth + 1);
  }
  return result;
}

function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;

  const context = requestContext.getStore();
  const entry = sanitize({
    time: new Date().toISOString(),
    level,
    message,
    ...(context ?? {}),
    ...(meta ?? {}),
  }) as Record<string, unknown>;

  const output = JSON.stringify(entry);

  if (level === "error") {
    console.error(output);
  } else if (level === "warn") {
    console.warn(output);
  } else {
    console.log(output);
  }
}

export function withRequestLogContext<T>(
  context: RequestLogContext,
  callback: () => T,
): T {
  return requestContext.run(context, callback);
}

export function getRequestLogContext(): RequestLogContext | undefined {
  return requestContext.getStore();
}

export const logger: Logger = {
  debug: (message, meta) => log("debug", message, meta),
  info: (message, meta) => log("info", message, meta),
  warn: (message, meta) => log("warn", message, meta),
  error: (message, meta) => log("error", message, meta),
};