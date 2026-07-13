import "dotenv/config";

import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().min(1).optional(),
  SLACK_SIGNING_SECRET: z
    .string()
    .regex(/^[a-f0-9]{32}$/u, "SLACK_SIGNING_SECRET must be a 32-character hexadecimal secret.")
    .optional(),
  SLACK_BOT_TOKEN: z
    .string()
    .min(20)
    .regex(/^xoxb-[A-Za-z0-9-]+$/u, "SLACK_BOT_TOKEN must be a Slack bot token.")
    .optional(),
});

export type KnotEnvironment = z.infer<typeof environmentSchema>;

export function loadEnvironment(source: NodeJS.ProcessEnv = process.env): KnotEnvironment {
  return environmentSchema.parse(source);
}

export function requireSlackEnvironment(
  environment: KnotEnvironment,
): Required<Pick<KnotEnvironment, "SLACK_SIGNING_SECRET" | "SLACK_BOT_TOKEN">> {
  if (!environment.SLACK_SIGNING_SECRET || !environment.SLACK_BOT_TOKEN) {
    throw new Error(
      "SLACK_SIGNING_SECRET and SLACK_BOT_TOKEN are required to start Slack HTTP mode.",
    );
  }

  return {
    SLACK_SIGNING_SECRET: environment.SLACK_SIGNING_SECRET,
    SLACK_BOT_TOKEN: environment.SLACK_BOT_TOKEN,
  };
}
