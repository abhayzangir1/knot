# Knot

Knot is a Slack-native outcome coordinator. It turns one selected message into
a confirmed Outcome Contract, obtains an explicit accountable owner, then
permits only a previewed and authorized reversible Slack-card update. It is not
a generic task manager or chatbot.

![Knot architecture](docs/architecture.svg)

The confirmation modal supports exactly five outcome types: **Request**,
**Decision**, **Commitment**, **Handoff**, and **Other**. The selected type
controls the closure-evidence rule; Knot never labels every outcome as a
request behind the scenes.

## Current Phase-1 implementation

The repository contains the automated walking-skeleton implementation below,
but the live Slack gate has **not** passed yet. Do not describe Knot as
publishable until the complete sandbox flow and its negative paths have current
recorded evidence in [PLANS.md](PLANS.md).

```text
Message shortcut
  -> private contract preview and confirmation
  -> owner invitation and acceptance
  -> role-specific private Knot Messages (no outcome channel)
  -> owner checks status; the named next-move owner prepares the progress update
  -> immutable Slack-card update preview
  -> independent approval (shared outcomes) or explicit self-confirmation (personal outcomes)
  -> named executor runs chat.update
  -> version-checked rollback
  -> type-appropriate owner attestation
  -> deterministic evidence-metadata and policy validation
  -> private closed projections and summaries
```

Private, personal outcomes can use the explicit self-confirmation exception for
their reversible card update. Shared outcomes require an independently selected
reviewer; the requester, owner, and executor cannot approve their own
consequential shared action.

Knot does not create one Slack channel per outcome. The accountable owner gets
the canonical status card in their private Knot Messages tab. That card exposes
**Check status**, owner-only closure and delegation, and the update control only
when the owner is also the named next-move actor. The creator gets correction
and deletion controls without receiving owner authority. A different
next-move actor alone receives **Prepare progress update**; the independent
reviewer receives **Review exact update** only after an immutable plan exists;
the named executor receives **Execute approved update** only after exact-plan
approval. Delegates see only the permissions in their current, versioned
delegation. After a successful update, the authorized recipient can use
**Restore previous card** subject to the version check. At closure, Knot sends
a detailed summary only to principals with both outcome-view and evidence
access; only the accountable owner can reopen it. Deletion removes private
outcome content but retains a non-sensitive audit tombstone.

## Run locally

1. Copy `.env.example` to `.env` and enter a PostgreSQL URL, Slack signing
   secret, and bot token.
2. Import `slack.json` in Slack and replace its placeholder interactivity URL
   with `https://YOUR-PUBLIC-HOST/slack/events`.
3. Start PostgreSQL and the app:

   ```sh
   docker compose up --build
   ```

   Or run the database locally and start the receiver with `npm run dev`.

4. Expose the loopback-bound port 3000 through an explicit TLS public URL for
   Slack. The receiver exposes `/healthz`, `/readyz`, and `/slack/events`.

The process requires a valid bot token at startup and exits rather than claiming
readiness if Slack authentication fails. The token is intentionally bound to
the exact workspace returned by `auth.test`; signed interactions from any other
team are rejected before durable work is accepted.

The manifest uses `users:read` only to confirm that owners, next-move owners,
and reviewers are active human members. Knot does not request user email
access.

## Verification

```sh
npm run check
```

To run the PostgreSQL integration suite, start `docker compose up -d db`, then
use the isolated-database runner:

```powershell
$env:TEST_DATABASE_ADMIN_URL='postgres://knot:knot@localhost:5433/postgres'
npm run test:postgres
```

The automated suites cover tenant-scoped identity mapping, durable command
receipts and crash recovery, content-hash collision rejection, RLS, outcome
state, concurrent approval/execution protection, compensation version checks,
private-delivery reconciliation, audience isolation, correction, reassignment,
delegation, reopening, deletion retention, and persisted audit events. The
isolated runner creates, migrates, tests, and removes a uniquely named database
so a running Knot worker cannot consume test jobs. PostgreSQL tests that are
skipped during the default unit run execute through `npm run test:postgres`.

The checked-in Docker and Render files are a bounded way to host this same
Phase-1 receiver at a stable TLS URL for the live Slack gate. They do not add a
product surface, connector, outcome type, or claim of a live deployment. The
image uses digest-pinned bases and a non-root runtime; account-side Render
configuration and the public endpoint still require live verification.

Passing automation does not by itself complete the live Slack gate. After any
manifest, scope, or deployment change, rerun the exact sandbox flow in
[Slack setup](docs/SLACK_SETUP.md) and capture acknowledgement latency, action
receipt, rollback, negative-role, and closure evidence before calling Phase 1
publishable.

With the receiver running on its final TLS URL, a safe signed negative-path
probe can measure edge-to-receiver acknowledgement latency without creating
domain state:

```powershell
$env:KNOT_PUBLIC_SLACK_URL='https://YOUR-PUBLIC-HOST/slack/events'
$env:KNOT_ACK_CONCURRENCY='1'
npm run measure:ack
```

This probe does not replace the live state-changing Slack flow. It proves only
the signed cross-workspace rejection path and fails when p95 is 500 ms or more,
p99 is one second or more, or any sample reaches three seconds.

See [Slack setup](docs/SLACK_SETUP.md), [deployment](docs/DEPLOYMENT.md), and
[local development](docs/LOCAL_DEVELOPMENT.md).
