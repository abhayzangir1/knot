import { describe, expect, it } from "vitest";

import { normalizePostgresConnectionString } from "../../src/db/client.js";

describe("PostgreSQL connection security", () => {
  it.each([
    "prefer",
    "require",
    "verify-ca",
  ])("makes pg 8's current %s behavior explicitly verify-full", (sslMode) => {
    const normalized = new URL(
      normalizePostgresConnectionString(
        `postgresql://user:password@example.test/database?sslmode=${sslMode}&channel_binding=require`,
      ),
    );

    expect(normalized.searchParams.get("sslmode")).toBe("verify-full");
    expect(normalized.searchParams.get("channel_binding")).toBe("require");
  });

  it("does not add TLS parameters to an explicitly local connection", () => {
    const normalized = new URL(
      normalizePostgresConnectionString("postgresql://user:password@localhost:5432/database"),
    );

    expect(normalized.searchParams.has("sslmode")).toBe(false);
  });
});
