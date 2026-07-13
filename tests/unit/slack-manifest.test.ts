import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Slack manifest least privilege", () => {
  it("matches every Phase-1 surface and scope invariant from D-030", async () => {
    const manifest = JSON.parse(await readFile("slack.json", "utf8")) as {
      features: {
        app_home: {
          home_tab_enabled: boolean;
          messages_tab_enabled: boolean;
          messages_tab_read_only_enabled: boolean;
        };
        assistant_view?: unknown;
        agent?: unknown;
      };
      oauth_config: { scopes: { bot: string[] } };
      settings: { event_subscriptions?: { bot_events?: string[] } };
    };

    expect(manifest.oauth_config.scopes.bot).toEqual([
      "chat:write",
      "im:write",
      "im:history",
      "users:read",
    ]);
    expect(manifest.features.app_home).toEqual({
      home_tab_enabled: false,
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: true,
    });
    expect(manifest.features).not.toHaveProperty("assistant_view");
    expect(manifest.features).not.toHaveProperty("agent");
    expect(manifest.settings.event_subscriptions?.bot_events ?? []).not.toContain("message.im");

    const prohibitedScopes = [
      "channels:manage",
      "channels:write",
      "groups:write",
      "groups:write.invites",
      "mpim:write",
      "users:read.email",
    ];
    expect(manifest.oauth_config.scopes.bot).not.toEqual(expect.arrayContaining(prohibitedScopes));
  });
});
