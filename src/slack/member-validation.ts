function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Slack role assignments must resolve to active human workspace members. */
export function isActiveHumanSlackMember(value: unknown, expectedSlackUserId: string): boolean {
  const user = record(value);
  return (
    user.id === expectedSlackUserId &&
    user.deleted !== true &&
    user.is_bot !== true &&
    user.is_app_user !== true
  );
}

export type SlackMemberPresentation = {
  plainName: string;
  locale: string;
  timeZone: string;
};

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Extracts notification/screen-reader-safe identity and locale data from users.info. */
export function slackMemberPresentation(
  value: unknown,
  expectedSlackUserId: string,
): SlackMemberPresentation {
  const user = record(value);
  if (user.id !== expectedSlackUserId) {
    return { plainName: "Slack member", locale: "en-US", timeZone: "UTC" };
  }
  const profile = record(user.profile);
  const plainName =
    nonEmptyString(profile.display_name_normalized) ??
    nonEmptyString(profile.display_name) ??
    nonEmptyString(profile.real_name_normalized) ??
    nonEmptyString(profile.real_name) ??
    nonEmptyString(user.real_name) ??
    nonEmptyString(user.name) ??
    "Slack member";
  const locale = nonEmptyString(user.locale) ?? "en-US";
  const requestedTimeZone = nonEmptyString(user.tz) ?? "UTC";
  let timeZone = "UTC";
  try {
    new Intl.DateTimeFormat(locale, { timeZone: requestedTimeZone }).format(new Date(0));
    timeZone = requestedTimeZone;
  } catch {
    // Slack can retain a legacy/invalid timezone; UTC is the deterministic safe fallback.
  }
  return { plainName, locale, timeZone };
}

export function formatSlackInstant(instant: string, member: SlackMemberPresentation): string {
  const value = new Date(instant);
  if (Number.isNaN(value.getTime())) {
    return "Invalid date";
  }
  try {
    return new Intl.DateTimeFormat(member.locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: member.timeZone,
      timeZoneName: "short",
    }).format(value);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
      timeZoneName: "short",
    }).format(value);
  }
}
