/** Slack Block Kit maxima plus a conservative, screen-reader-friendly fallback target. */
export const slackTextLimits = {
  section: 3_000,
  field: 2_000,
  context: 2_000,
  header: 150,
  fallback: 4_000,
} as const;

const ELLIPSIS = "\u2026";

/**
 * Conservatively bounds a final text payload without cutting a UTF-16 surrogate
 * pair or one of the HTML entities Slack expects in escaped mrkdwn.
 */
export function truncateSlackText(value: string, limit: number): string {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("Slack text limit must be a positive safe integer.");
  }
  if (value.length <= limit) {
    return value;
  }
  if (limit === 1) {
    return ELLIPSIS;
  }

  let end = limit - ELLIPSIS.length;
  const lastCodeUnit = value.charCodeAt(end - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    end -= 1;
  }

  // The dynamic mrkdwn escaper emits &amp;, &lt;, and &gt;. If the boundary
  // lands inside one, remove the complete partial entity before appending the
  // ellipsis so Slack never receives malformed entity syntax.
  const lastAmpersand = value.lastIndexOf("&", end - 1);
  const lastSemicolon = value.lastIndexOf(";", end - 1);
  if (lastAmpersand > lastSemicolon) {
    end = lastAmpersand;
  }

  return `${value.slice(0, end)}${ELLIPSIS}`;
}

export function escapeMrkdwn(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Bounds a complete mrkdwn string after every dynamic value has been escaped. */
export function boundedMrkdwn(value: string, limit: number = slackTextLimits.section): string {
  return truncateSlackText(value, limit);
}

export function boundedPlainText(value: string, limit: number): string {
  return truncateSlackText(value, limit);
}
