import { describe, expect, it } from "vitest";

import {
  formatSlackInstant,
  isActiveHumanSlackMember,
  slackMemberPresentation,
} from "../../src/slack/member-validation.js";

describe("Slack role-assignment member validation", () => {
  it("accepts an active human member with the expected identity", () => {
    expect(
      isActiveHumanSlackMember(
        { id: "U123", deleted: false, is_bot: false, is_app_user: false },
        "U123",
      ),
    ).toBe(true);
  });

  it.each([
    [{ id: "U123", is_bot: true }, "a bot"],
    [{ id: "U123", is_app_user: true }, "an app user"],
    [{ id: "U123", deleted: true }, "a deleted member"],
    [{ id: "U999" }, "an identity mismatch"],
    [{}, "a missing user"],
  ] as const)("rejects %s (%s)", (user, _description) => {
    expect(isActiveHumanSlackMember(user, "U123")).toBe(false);
  });

  it("produces a plain display name and localized time without exposing an opaque Slack ID", () => {
    const presentation = slackMemberPresentation(
      {
        id: "U123",
        locale: "en-US",
        tz: "America/New_York",
        profile: { display_name_normalized: "Release Owner" },
      },
      "U123",
    );

    expect(presentation.plainName).toBe("Release Owner");
    const formatted = formatSlackInstant("2026-07-13T16:00:00.000Z", presentation);
    expect(formatted).toContain("Jul");
    expect(formatted).not.toContain("2026-07-13T16:00:00.000Z");
  });

  it("fails safely to a generic identity and UTC for mismatched or invalid member metadata", () => {
    const presentation = slackMemberPresentation(
      { id: "U999", locale: "invalid_locale", tz: "Not/AZone", name: "Wrong user" },
      "U123",
    );
    expect(presentation).toEqual({ plainName: "Slack member", locale: "en-US", timeZone: "UTC" });
  });
});
