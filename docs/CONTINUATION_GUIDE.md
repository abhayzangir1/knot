# Knot continuation guide

## Frozen handoff snapshot

This repository was packaged as an honest continuation snapshot on
2026-07-14 and tagged `archive-2026-07-14`. It preserves the implementation
that existed when the Slack Agent Builder Challenge closed. It is not a claim
that the hackathon submission, live acceptance gate, or planned product was
complete.

The snapshot is intentionally frozen at these boundaries:

- The default automated gate passes formatting, linting, type checking, 176
  tests, and the production TypeScript build. Five PostgreSQL-gated tests are
  skipped by the default run. The fresh 2026-07-14 isolated database run passed
  all 181 tests and removed its disposable database.
- The Slack walking-skeleton code is present, but the complete shared and
  personal sandbox flows and all required negative paths do not yet have
  current acceptance evidence.
- The stable receiver and database readiness endpoints were reachable during
  the final audit, but free hosting has no uptime guarantee.
- Knot Core MCP, Slack AI, RTS, Linear, multi-workspace OAuth, and the broader
  Phase-2 release are not implemented.
- The Devpost description and video script in this repository are unsubmitted
  future templates. Their MCP and complete-flow passages describe the intended
  target, not behavior available in this snapshot.

The source of truth remains [PLANS.md](../PLANS.md),
[ARCHITECTURE.md](ARCHITECTURE.md),
[OUTCOME_LIFECYCLE.md](OUTCOME_LIFECYCLE.md), and
[DECISIONS.md](DECISIONS.md). Do not mark a gate complete without the evidence
required there.

## What is implemented

- Signed Slack HTTP ingress with timestamp/replay rejection and workspace
  installation binding.
- Durable, workspace-scoped command receipts and asynchronous job processing.
- A deterministic outcome service with optimistic concurrency, idempotency,
  audience checks, role separation, append-only audits, and redacted deletion
  integrity.
- Slack message shortcut, contract confirmation, owner acceptance,
  role-specific private cards, status, exact action preview, approval,
  execution/compensation services, closure, correction, delegation,
  reassignment, reopening, and deletion paths.
- PostgreSQL migrations with forced tenant RLS, migration serialization, and
  isolated database test support.
- Non-root Docker packaging, one-service Render packaging, health/readiness
  endpoints, and a signed acknowledgement probe.

Implementation does not equal acceptance. The live paths above still need the
recorded sandbox evidence listed in [PLANS.md](../PLANS.md) and
[SUBMISSION_CHECKLIST.md](SUBMISSION_CHECKLIST.md).

## Recommended continuation order

1. Create a new branch from `archive-2026-07-14`; do not rewrite the archived
   tag.
2. Install Node.js 24+ and npm 11+, run `npm ci`, then run `npm run check`.
3. Start a disposable PostgreSQL instance and run the isolated suite:

   ```powershell
   docker compose up -d db
   $env:TEST_DATABASE_ADMIN_URL='postgres://knot:knot@localhost:5433/postgres'
   npm run test:postgres
   ```

4. Follow [SLACK_SETUP.md](SLACK_SETUP.md) and record the complete shared flow:
   creation, owner acceptance, status, exact preview, independent approval,
   execution receipt, rollback, owner-attested closure, and reopen.
5. Record the private single-message path and every required denial, replay,
   duplicate, stale-state, correction, delegation, reassignment, deletion, and
   tenant/audience path. Update `PLANS.md` only with actual evidence.
6. After Phase 1 passes, implement Knot Core MCP as the authenticated thin
   adapter specified by D-014 and D-044. Add protocol, identity,
   authorization, tenant-isolation, schema, output, audit, and live Slackbot
   tests before describing it as available.
7. Rerun the full automated, PostgreSQL, container, deployment, ingress,
   accessibility, and live Slack gates before starting the remaining Phase-2
   scope.

## Repository map

| Path | Purpose |
| --- | --- |
| `src/services/` | Deterministic application services; the domain authority |
| `src/outcomes/` | Outcome contract, lifecycle, policy, and execution types |
| `src/slack/` | Thin Slack ingress, durable commands, cards, and views |
| `src/db/` and `drizzle/` | Tenant-scoped persistence and ordered migrations |
| `tests/unit/` | Fast policy, lifecycle, Slack, packaging, and service coverage |
| `tests/integration/` | PostgreSQL queue and walking-skeleton coverage |
| `docs/` | Architecture, lifecycle, decisions, setup, evidence, and handoff |

## Security and contribution rules

- Never commit `.env`, Slack tokens, signing secrets, database URLs, private
  Slack content, browser state, or sensitive evidence.
- Treat Slack input, URLs, connector/model/MCP output, and file metadata as
  untrusted evidence.
- Keep Slack and future MCP handlers thin. Authorization, lifecycle, approval,
  execution, compensation, closure, and audit decisions remain deterministic
  application-service responsibilities.
- Preserve tenant scope, optimistic concurrency, idempotency, receipts, and
  append-only audit integrity in every behavior change.
- Add tests and a decision record for every material product, architecture,
  security, platform, or policy change.

Knot is available under the repository's [MIT License](../LICENSE). Forks and
continued development are welcome when they preserve the documented safety
and truthfulness boundaries.
