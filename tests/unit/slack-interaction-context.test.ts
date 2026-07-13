import { describe, expect, it, vi } from "vitest";

import {
  InMemoryInteractionContextStore,
  SHORTCUT_CONTEXT_TTL_MILLISECONDS,
} from "../../src/slack/interaction-context.js";

describe("Slack interaction context lifetime", () => {
  it("allows a careful one-hour actor-bound review and remains single-use", async () => {
    vi.useFakeTimers();
    try {
      const createdAt = new Date("2026-07-14T00:00:00.000Z");
      vi.setSystemTime(createdAt);
      const store = new InMemoryInteractionContextStore();
      const creator = { workspaceId: "workspace-1", principalId: "principal-1" };
      const context = await store.create({
        creator,
        source: {
          channelId: "C123",
          messageTs: "1710000000.000100",
          text: "A loose end",
          permalink: "https://example.slack.com/archives/C123/p1710000000000100",
          observedAt: createdAt.toISOString(),
        },
      });

      expect(Date.parse(context.expiresAt) - createdAt.getTime()).toBe(
        SHORTCUT_CONTEXT_TTL_MILLISECONDS,
      );
      vi.advanceTimersByTime(SHORTCUT_CONTEXT_TTL_MILLISECONDS - 1);
      await expect(store.get(context.reference, creator)).resolves.toBeDefined();
      await expect(store.consume(context.reference, creator)).resolves.toBeDefined();
      await expect(store.consume(context.reference, creator)).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires the preview after the bounded review window", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-14T00:00:00.000Z"));
      const store = new InMemoryInteractionContextStore();
      const creator = { workspaceId: "workspace-1", principalId: "principal-1" };
      const context = await store.create({
        creator,
        source: {
          channelId: "C123",
          messageTs: "1710000000.000100",
          text: "A loose end",
          permalink: "https://example.slack.com/archives/C123/p1710000000000100",
          observedAt: "2026-07-14T00:00:00.000Z",
        },
      });

      vi.advanceTimersByTime(SHORTCUT_CONTEXT_TTL_MILLISECONDS);
      await expect(store.get(context.reference, creator)).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
