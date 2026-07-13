import { describe, expect, it } from "vitest";

import { duplicateIngressFeedback, statusProjectionReceipt } from "../../src/slack/app.js";
import { InMemorySlackIngressReceiptStore } from "../../src/slack/ingress-receipts.js";

describe("Slack ingress receipts", () => {
  it("deduplicates a retry without conflating deliveries from different workspaces", async () => {
    const store = new InMemorySlackIngressReceiptStore();
    const receipt = {
      deliveryKey: "owner-accept:T1:U1:outcome-1:click-1",
      workspaceSlackTeamId: "T1",
      payload: { action: "owner_accept" },
    };

    await expect(store.claim(receipt)).resolves.toBe(true);
    await expect(store.claim(receipt)).resolves.toBe(false);
    await expect(store.claim({ ...receipt, workspaceSlackTeamId: "T2" })).resolves.toBe(true);
  });

  it("fails closed when a delivery key is reused for different content", async () => {
    const store = new InMemorySlackIngressReceiptStore();
    const receipt = {
      deliveryKey: "owner-accept:T1:U1:outcome-1:click-2",
      workspaceSlackTeamId: "T1",
      payload: { action: "owner_accept" },
    };

    await expect(store.claim(receipt)).resolves.toBe(true);
    await expect(store.claim({ ...receipt, payload: { action: "owner_decline" } })).rejects.toThrow(
      "refused the collision",
    );
  });

  it("terminates duplicate preparing surfaces with explicit no-duplicate feedback", () => {
    expect(duplicateIngressFeedback("shortcut")).toContain("did not create a duplicate outcome");
    expect(duplicateIngressFeedback("exact_review")).toContain(
      "did not create a duplicate approval",
    );
  });

  it("coalesces repeated unchanged status projections but permits a changed status", async () => {
    const store = new InMemorySlackIngressReceiptStore();
    const identity = { slackTeamId: "T1", slackUserId: "U1" };
    const active = statusProjectionReceipt(identity, "outcome-1", {
      state: "active",
      reason: "The contract is active.",
      nextMove: "Prepare the update.",
      evidenceStatus: "missing",
    });
    const closed = statusProjectionReceipt(identity, "outcome-1", {
      state: "closed",
      reason: "The owner supplied closure evidence.",
      nextMove: "No further action is required.",
      evidenceStatus: "available",
    });

    await expect(store.claim(active)).resolves.toBe(true);
    await expect(store.claim(active)).resolves.toBe(false);
    await expect(store.claim(closed)).resolves.toBe(true);
    expect(closed.deliveryKey).not.toBe(active.deliveryKey);
  });
});
