import { describe, expect, it } from "vitest";

import { loadEnvironment, requireSlackEnvironment } from "../../src/config/env.js";

const validBotToken = ["xoxb", "1234567890", "abcdefghijklmnop"].join("-");
const invalidUserToken = ["xoxp", "1234567890", "abcdefghijklmnop"].join("-");

describe("runtime environment boundary", () => {
  it("accepts well-formed Slack credentials without returning their values in errors", () => {
    const environment = loadEnvironment({
      NODE_ENV: "production",
      SLACK_SIGNING_SECRET: "a".repeat(32),
      SLACK_BOT_TOKEN: validBotToken,
    });

    expect(requireSlackEnvironment(environment)).toEqual({
      SLACK_SIGNING_SECRET: "a".repeat(32),
      SLACK_BOT_TOKEN: validBotToken,
    });
  });

  it("rejects a malformed signing secret before the HTTP receiver starts", () => {
    expect(() =>
      loadEnvironment({
        SLACK_SIGNING_SECRET: "not-a-signing-secret",
        SLACK_BOT_TOKEN: validBotToken,
      }),
    ).toThrow(/32-character hexadecimal/iu);
  });

  it("rejects a non-bot Slack token before auth.test", () => {
    expect(() =>
      loadEnvironment({
        SLACK_SIGNING_SECRET: "a".repeat(32),
        SLACK_BOT_TOKEN: invalidUserToken,
      }),
    ).toThrow(/Slack bot token/iu);
  });

  it("keeps Slack credentials optional for migration-only processes but required for HTTP mode", () => {
    const environment = loadEnvironment({ NODE_ENV: "test" });

    expect(() => requireSlackEnvironment(environment)).toThrow(
      "SLACK_SIGNING_SECRET and SLACK_BOT_TOKEN are required",
    );
  });
});
