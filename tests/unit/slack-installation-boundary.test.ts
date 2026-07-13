import { describe, expect, it, vi } from "vitest";

import { verifiedIdentityFromPayload, verifiedIdentityOrAcknowledge } from "../../src/slack/app.js";

describe("Slack installation identity boundary", () => {
  it("accepts only the workspace authenticated by the configured bot token", () => {
    expect(
      verifiedIdentityFromPayload(
        { team: { id: "TEXPECTED" }, user: { id: "UACTOR" } },
        "test",
        "TEXPECTED",
      ),
    ).toMatchObject({ slackTeamId: "TEXPECTED", slackUserId: "UACTOR" });

    expect(() =>
      verifiedIdentityFromPayload(
        { team: { id: "TFOREIGN" }, user: { id: "UACTOR" } },
        "test",
        "TEXPECTED",
      ),
    ).toThrow("does not belong");
  });

  it("rejects missing and unbounded signed-payload identity values", () => {
    expect(() =>
      verifiedIdentityFromPayload({ team: { id: "TEXPECTED" } }, "test", "TEXPECTED"),
    ).toThrow("include a user ID");
    expect(() =>
      verifiedIdentityFromPayload(
        { team: { id: "TEXPECTED" }, user: { id: `U${"A".repeat(100)}` } },
        "test",
        "TEXPECTED",
      ),
    ).toThrow("outside the accepted boundary");
    expect(() =>
      verifiedIdentityFromPayload(
        { team: { id: "TEXPECTED" }, user: { id: "UACTOR:forged" } },
        "test",
        "TEXPECTED",
      ),
    ).toThrow("outside the accepted boundary");
  });

  it("acknowledges an invalid installation identity without enqueuing domain work", async () => {
    const acknowledge = vi.fn(async () => undefined);
    const warn = vi.fn();

    await expect(
      verifiedIdentityOrAcknowledge({
        payload: { team: { id: "TFOREIGN" }, user: { id: "UACTOR" } },
        label: "owner-accept",
        expectedSlackTeamId: "TEXPECTED",
        acknowledge,
        logger: { warn } as never,
      }),
    ).resolves.toBeUndefined();
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
  });
});
