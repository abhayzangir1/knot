import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";

import { postPrivateMessageOnce } from "../../src/slack/app.js";

function fakeClient(input?: { existingDeliveryId?: string }): {
  client: WebClient;
  open: ReturnType<typeof vi.fn>;
  history: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
} {
  const open = vi.fn().mockResolvedValue({ ok: true, channel: { id: "D123" } });
  const history = vi.fn().mockResolvedValue({
    ok: true,
    messages: input?.existingDeliveryId
      ? [
          {
            ts: "171234.000001",
            metadata: {
              event_type: "knot_delivery",
              event_payload: { delivery_id: input.existingDeliveryId },
            },
          },
        ]
      : [],
  });
  const postMessage = vi.fn().mockResolvedValue({ ok: true, ts: "171234.000002" });
  return {
    client: {
      conversations: { open, history },
      chat: { postMessage },
    } as unknown as WebClient,
    open,
    history,
    postMessage,
  };
}

describe("recoverable private Slack delivery", () => {
  it("posts a first attempt without consuming the history rate limit", async () => {
    const slack = fakeClient();

    await expect(
      postPrivateMessageOnce(slack.client, "U123", "delivery-1", { text: "Safe status" }),
    ).resolves.toEqual({ channelId: "D123", messageTs: "171234.000002" });

    expect(slack.open).toHaveBeenCalledWith({ users: "U123" });
    expect(slack.history).not.toHaveBeenCalled();
    expect(slack.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "D123",
        text: "Safe status",
        metadata: {
          event_type: "knot_delivery",
          event_payload: { delivery_id: "delivery-1" },
        },
      }),
    );
  });

  it("reconciles an ambiguous retry by opaque metadata without posting twice", async () => {
    const slack = fakeClient({ existingDeliveryId: "delivery-2" });

    await expect(
      postPrivateMessageOnce(slack.client, "U234", "delivery-2", {
        text: "Safe status",
        reconcileExisting: true,
      }),
    ).resolves.toEqual({ channelId: "D123", messageTs: "171234.000001" });

    expect(slack.history).toHaveBeenCalledWith({
      channel: "D123",
      include_all_metadata: true,
      limit: 15,
    });
    expect(slack.postMessage).not.toHaveBeenCalled();
  });
});
