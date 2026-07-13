import { describe, expect, it } from "vitest";

import { normalizeSlackMessageText, shortcutSource } from "../../src/slack/app.js";

describe("Slack shortcut source boundary", () => {
  it("normalizes Slack markup into readable inert source text", () => {
    const text = normalizeSlackMessageText(
      "<@UABC123|Alice> asked <!here> in <#C123|launch> to read <https://example.test/plan|the plan> with <!subteam^S123|devs>.",
    );

    expect(text).toBe(
      "@workspace member asked @here in #launch to read the plan (https://example.test/plan) with @devs.",
    );
  });

  it("accepts a selected human-authored message and returns only bounded source fields", () => {
    expect(
      shortcutSource({
        channel: { id: "C123" },
        message: {
          ts: "1710000000.000100",
          user: "UABC123",
          text: "Please ask <@UDEF456> to publish the demo.",
        },
      }),
    ).toEqual({
      channelId: "C123",
      messageTs: "1710000000.000100",
      text: "Please ask @workspace member to publish the demo.",
    });
  });

  it.each([
    ["bot message", { user: "UABC123", bot_id: "B123", text: "Bot output" }],
    ["app message", { user: "UABC123", app_id: "A123", text: "App output" }],
    ["join message", { user: "UABC123", subtype: "channel_join", text: "joined" }],
    ["system message without a human author", { subtype: "channel_name", text: "renamed" }],
  ])("rejects a %s", (_label, message) => {
    expect(() =>
      shortcutSource({
        channel: { id: "C123" },
        message: { ts: "1710000000.000100", ...message },
      }),
    ).toThrow("human-authored Slack messages");
  });

  it("rejects a human-authored message with no usable text", () => {
    expect(() =>
      shortcutSource({
        channel: { id: "C123" },
        message: { ts: "1710000000.000100", user: "UABC123", text: "   " },
      }),
    ).toThrow("with text");
  });
});
