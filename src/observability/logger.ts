import pino from "pino";

import type { KnotEnvironment } from "../config/env.js";

function safeErrorLog(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return { type: "unknown_error" };
  }
  const error = value as Record<string, unknown>;
  const providerData =
    error.data && typeof error.data === "object"
      ? (error.data as Record<string, unknown>)
      : undefined;
  const code =
    typeof error.code === "string"
      ? error.code
      : typeof providerData?.error === "string"
        ? providerData.error
        : undefined;
  return {
    type:
      typeof error.name === "string"
        ? error.name
        : value instanceof Error
          ? value.name
          : "unknown_error",
    ...(code && /^[a-z0-9_.-]{1,120}$/iu.test(code) ? { code } : {}),
    ...(typeof error.statusCode === "number" ? { statusCode: error.statusCode } : {}),
  };
}

export function createLogger(environment: Pick<KnotEnvironment, "LOG_LEVEL" | "NODE_ENV">) {
  return pino({
    level: environment.LOG_LEVEL,
    serializers: { err: safeErrorLog },
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers['x-slack-signature']",
        "req.body.token",
        "*.token",
        "*.botToken",
        "*.signingSecret",
        "*.authorization",
        "*.headers.authorization",
        "*.headers.Authorization",
        "err.config.headers.authorization",
        "err.config.headers.Authorization",
        "err.request.headers.authorization",
        "*.accessToken",
        "*.refreshToken",
        "*.clientSecret",
        "*.apiKey",
      ],
      censor: "[REDACTED]",
    },
    base: {
      service: "knot",
      environment: environment.NODE_ENV,
    },
  });
}

export type KnotLogger = ReturnType<typeof createLogger>;
