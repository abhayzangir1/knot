import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

async function repositoryFile(name: string): Promise<string> {
  return readFile(new URL(`../../${name}`, import.meta.url), "utf8");
}

describe("production packaging boundary", () => {
  it("keeps the final image reproducible, non-root, minimal, and free of package tooling", async () => {
    const dockerfile = await repositoryFile("Dockerfile");

    expect(dockerfile.match(/FROM node:24-alpine@sha256:[a-f0-9]{64}/gu)).toHaveLength(2);
    expect(dockerfile).toContain("npm ci --omit=dev");
    expect(dockerfile).toContain("rm -rf /usr/local/lib/node_modules/npm");
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).toContain('ENTRYPOINT ["./docker-entrypoint.sh"]');
    expect(dockerfile).not.toContain("COPY . .");
    expect(dockerfile).not.toMatch(/COPY\s+\.env/iu);
  });

  it("keeps Render secrets account-side and requires managed readiness", async () => {
    const blueprint = await repositoryFile("render.yaml");

    expect(blueprint).toContain(
      "# yaml-language-server: $schema=https://render.com/schema/render.yaml.json",
    );
    expect(blueprint).toContain("healthCheckPath: /readyz");
    expect(blueprint).toContain("fromDatabase:");
    expect(blueprint).toContain('postgresMajorVersion: "17"');
    expect(blueprint).toContain("ipAllowList: []");
    expect(blueprint.match(/sync: false/gu)).toHaveLength(2);
    expect(blueprint).not.toMatch(/xox[baprs]-/iu);
  });

  it("binds local database and receiver ports to loopback", async () => {
    const compose = await repositoryFile("compose.yaml");

    expect(compose).toContain('"127.0.0.1:5433:5432"');
    expect(compose).toContain('"127.0.0.1:3000:3000"');
    expect(compose).not.toContain('- "3000:3000"');
  });

  it("makes signature and replay rejection part of the deployment acknowledgement probe", async () => {
    const probe = await repositoryFile("scripts/measure-slack-ack.mjs");

    for (const check of ["unsigned-request", "forged-signature", "stale-replay"]) {
      expect(probe).toContain(check);
    }
    expect(probe).toContain("response.status !== 401");
    expect(probe).toContain("p95 >= 500 || p99 >= 1000 || maximum >= 3000");
  });

  it("excludes local secrets and development artifacts from the Docker context", async () => {
    const dockerignore = await repositoryFile(".dockerignore");

    for (const ignored of ["node_modules", "dist", "coverage", ".git", ".env", "*.log"]) {
      expect(dockerignore.split(/\r?\n/u)).toContain(ignored);
    }
    expect(dockerignore).toContain("!.env.example");
  });
});
