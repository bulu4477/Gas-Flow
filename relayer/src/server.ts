import crypto from "node:crypto";
import http from "node:http";
import { config } from "./config";
import { handleSubmit } from "./routes/submit";
import { handleEstimate } from "./routes/estimate";
import { handleStatus } from "./routes/status";
import { handleConfig } from "./routes/config";
import { handleBalance } from "./routes/balance";
import { runStartupChecks } from "./services/startupCheck";
import { startBalanceMonitor } from "./services/balanceMonitor";
import { getRelayerAddress, getPublicClient, readConfig } from "./services/clients";
import { nonceManager } from "./services/nonceManager";
import { logger, withRequestLogContext } from "./utils/logger";
import { metrics } from "./utils/metrics";
import {
  READ_BODY_TIMEOUT_MS,
  SHUTDOWN_TIMEOUT_MS,
} from "./utils/constants";

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", {
    error: err.message,
    stack: err.stack,
  });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  process.exit(1);
});

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimits = new Map<string, RateLimitEntry>();

function getClientIp(req: http.IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimits.get(ip);

  if (!entry || now >= entry.resetAt) {
    rateLimits.set(ip, { count: 1, resetAt: now + config.rateLimitWindowMs });
    return false;
  }

  entry.count += 1;
  return entry.count > config.rateLimitMaxRequests;
}

function isApiKeyValid(req: http.IncomingMessage): boolean {
  if (!config.relayerApiKey) return true;
  const provided = req.headers["x-api-key"];
  return typeof provided === "string" && provided === config.relayerApiKey;
}

function readBody(
  req: http.IncomingMessage,
  maxSize: number,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    const timer = setTimeout(() => {
      reject(Object.assign(new Error("Request body read timeout"), { statusCode: 408 }));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      req.removeAllListeners("data");
      req.removeAllListeners("end");
      req.removeAllListeners("error");
    };

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        cleanup();
        reject(Object.assign(new Error("Request body too large"), { statusCode: 413 }));
        return;
      }
      data += chunk.toString("utf8");
    });

    req.on("end", () => {
      cleanup();
      resolve(data);
    });

    req.on("error", (err) => {
      cleanup();
      reject(err);
    });
  });
}

function jsonResponse(
  res: http.ServerResponse,
  statusCode: number,
  body: unknown,
) {
  if (!res.hasHeader("X-Request-Id")) {
    res.setHeader("X-Request-Id", "unknown");
  }
  const requestId = String(res.getHeader("X-Request-Id") ?? "unknown");
  const responseBody =
    body &&
    typeof body === "object" &&
    "error" in body &&
    !("requestId" in body)
      ? { ...(body as Record<string, unknown>), requestId }
      : body;
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key, X-Request-Id",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  res.end(JSON.stringify(responseBody, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
}

async function handleHealth(res: http.ServerResponse): Promise<void> {
  try {
    const relayerAddress = getRelayerAddress();
    const publicClient = getPublicClient();
    const [ethBalance, isWhitelisted, isPaused] = await Promise.all([
      publicClient.getBalance({ address: relayerAddress }),
      readConfig.relayers(relayerAddress),
      readConfig.paused(),
    ]);

    jsonResponse(res, 200, {
      status: "ok",
      relayerAddress,
      ethBalance: ethBalance.toString(),
      minBalance: config.minRelayerBalance.toString(),
      isWhitelisted,
      isPaused,
      pendingTxCount: nonceManager.getPendingCount(),
    });
  } catch (error) {
    logger.error("Health check failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    jsonResponse(res, 503, { status: "unhealthy" });
  }
}

function handleMetrics(res: http.ServerResponse): void {
  const snapshot = metrics.getSnapshot();
  jsonResponse(res, 200, {
    submit: snapshot.submit,
    estimate: snapshot.estimate,
    simulate: snapshot.simulate,
    totalGasUsed: snapshot.totalGasUsed.toString(),
  });
}

function getRequestId(req: http.IncomingMessage): string {
  const provided = req.headers["x-request-id"];
  if (typeof provided === "string" && provided.trim().length > 0) {
    return provided.trim().slice(0, 128);
  }
  return crypto.randomUUID();
}

async function handleRequestInner(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const startedAt = Date.now();
  const finishLog = () => {
    logger.info("Request completed", {
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  };
  res.once("finish", finishLog);

  logger.info("Incoming request", { method: req.method, url: req.url });

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-API-Key, X-Request-Id",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    await handleHealth(res);
    return;
  }

  if (req.method === "GET" && req.url === "/metrics") {
    handleMetrics(res);
    return;
  }

  const clientIp = getClientIp(req);
  logger.info("Rate limit check", { clientIp });
  if (isRateLimited(clientIp)) {
    logger.warn("Rate limit exceeded", { clientIp });
    jsonResponse(res, 429, { error: "Rate limit exceeded" });
    return;
  }

  if (req.method === "POST" && !isApiKeyValid(req)) {
    logger.warn("Unauthorized request", { clientIp });
    jsonResponse(res, 401, { error: "Unauthorized" });
    return;
  }

  logger.info("Auth and rate limit passed", { clientIp });

  if (req.method === "POST" && req.url === "/api/v1/submit") {
    const start = Date.now();
    try {
      logger.info("Submit: reading body...");
      const rawBody = await readBody(req, config.maxBodySize, READ_BODY_TIMEOUT_MS);
      logger.info("Submit: parsing JSON...");
      const body = JSON.parse(rawBody);
      logger.info("Submit: calling handleSubmit...");
      const result = await handleSubmit(body);
      metrics.recordSubmit(true);
      logger.info("Submit succeeded", {
        clientIp,
        durationMs: Date.now() - start,
        txHash: result.txHash,
      });
      jsonResponse(res, 200, result);
    } catch (error: unknown) {
      const err = error as Error & { statusCode?: number };
      metrics.recordSubmit(false);
      logger.error("Submit failed", {
        clientIp,
        durationMs: Date.now() - start,
        error: err.message,
        statusCode: err.statusCode ?? 500,
      });
      jsonResponse(res, err.statusCode || 500, {
        error: err.message || "Internal server error",
      });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/v1/estimate") {
    const start = Date.now();
    try {
      const rawBody = await readBody(req, config.maxBodySize, READ_BODY_TIMEOUT_MS);
      const body = JSON.parse(rawBody);
      const result = await handleEstimate(body);
      metrics.recordEstimate(true);
      logger.info("Estimate succeeded", {
        clientIp,
        durationMs: Date.now() - start,
      });
      jsonResponse(res, 200, result);
    } catch (error: unknown) {
      const err = error as Error & { statusCode?: number };
      metrics.recordEstimate(false);
      logger.error("Estimate failed", {
        clientIp,
        durationMs: Date.now() - start,
        error: err.message,
        statusCode: err.statusCode ?? 500,
      });
      jsonResponse(res, err.statusCode || 500, {
        error: err.message || "Internal server error",
      });
    }
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/api/v1/status/")) {
    try {
      const txHash = req.url.slice("/api/v1/status/".length);
      const result = await handleStatus(txHash as `0x${string}`);
      jsonResponse(res, 200, result);
    } catch (error: unknown) {
      const err = error as Error & { statusCode?: number };
      logger.error("Status lookup failed", { error: err.message });
      jsonResponse(res, err.statusCode || 500, {
        error: err.message || "Internal server error",
      });
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/v1/config") {
    try {
      const result = await handleConfig();
      jsonResponse(res, 200, result);
    } catch (error: unknown) {
      const err = error as Error & { statusCode?: number };
      logger.error("Config lookup failed", { error: err.message });
      jsonResponse(res, err.statusCode || 500, {
        error: err.message || "Internal server error",
      });
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/v1/balance") {
    try {
      const result = await handleBalance();
      jsonResponse(res, 200, result);
    } catch (error: unknown) {
      const err = error as Error & { statusCode?: number };
      logger.error("Balance lookup failed", { error: err.message });
      jsonResponse(res, err.statusCode || 500, {
        error: err.message || "Internal server error",
      });
    }
    return;
  }

  jsonResponse(res, 404, { error: "Not found" });
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const requestId = getRequestId(req);
  const clientIp = getClientIp(req);
  const path = req.url?.split("?")[0] ?? "/";
  res.setHeader("X-Request-Id", requestId);

  return withRequestLogContext(
    {
      requestId,
      method: req.method,
      path,
      clientIp,
    },
    () => handleRequestInner(req, res),
  );
}

function createServer(): http.Server {
  return http.createServer(handleRequest);
}

function setupGracefulShutdown(server: http.Server): void {
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down gracefully", { signal });
    server.close((err) => {
      if (err) {
        logger.error("Error closing server", { error: err.message });
        process.exit(1);
      }
      logger.info("Server closed gracefully");
      process.exit(0);
    });

    setTimeout(() => {
      logger.error("Graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

export async function start(): Promise<void> {
  await runStartupChecks();
  const server = createServer();
  setupGracefulShutdown(server);

  server.listen(config.port, () => {
    logger.info("GasFlow Relayer started", {
      port: config.port,
      logLevel: config.logLevel,
      relayerAddress: getRelayerAddress(),
    });

    startBalanceMonitor();
  });
}

start().catch((err) => {
  logger.error("Startup failed", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
