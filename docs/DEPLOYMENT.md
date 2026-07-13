# Phase-1 deployment and live verification

This runbook deploys only the tested Phase-1 Slack receiver. It does not make
the single-workspace, non-rotating installation suitable for Slack Marketplace
distribution; D-035 remains the credential-lifecycle boundary.

## Stable Render deployment

The checked-in Blueprint deliberately requests one Render **Free** web service.
Durable state uses a separate Neon Free PostgreSQL project because Neon has no
Free-plan time limit, whereas Render Free PostgreSQL expires after 30 days.
Neither provider offers a production SLA on these Free plans. The combination
is a zero-cost continuity design for the hackathon judging window, not a claim
of always-on production infrastructure.

1. Use the public GitHub repository at the exact tested revision. Confirm that
   `.env`, logs, database URLs, and credentials are absent from the commit and
   repository history.
2. Create a Neon Free project named `knot` in **AWS US West (Oregon)** and use
   PostgreSQL 17. Do not enable Neon Auth or add sample data. In **Connect**,
   select the primary branch and copy the **Direct connection** string with
   `sslmode=require`. The direct endpoint is required because Knot's serialized
   migrator takes a session-level PostgreSQL advisory lock; the application
   already bounds its own pool.
3. In Render, create a Blueprint from the repository's root `render.yaml`. The
   Blueprint creates only one Oregon web service on `plan: free`; it cannot
   silently create a paid or expiring Render database.
4. Enter `DATABASE_URL`, `SLACK_SIGNING_SECRET`, and `SLACK_BOT_TOKEN` only in
   Render's secret fields. `DATABASE_URL` is the Neon Direct connection string.
   Never put any of these values in `render.yaml`, a deploy URL, build log, chat,
   screenshot, or commit. Rotate any credential that has left the trusted
   secret stores.
5. Wait for the Docker build, serialized database migrations, and `/healthz`
   liveness check to pass. Then open `/readyz` and require HTTP 200; this proves
   the external database and durable worker are ready. A successful build or
   liveness response without readiness is not a successful deployment.
6. Open both endpoints from a separate network path:

   ```text
   https://YOUR-RENDER-HOST/healthz
   https://YOUR-RENDER-HOST/readyz
   ```

7. Create one Free UptimeRobot **HTTP(s)** monitor for the exact HTTPS
   `/healthz` URL with the Free plan's five-minute interval. Keep it enabled
   until winners are actually announced, including any delay. Configure email
   alerts, confirm the monitor sees HTTP 200, and never include a token or other
   secret in the URL. Monitoring liveness keeps Render warm without running a
   Neon query every five minutes and exhausting Neon Free compute. On any alert,
   also check `/readyz`. This external availability probe is operational hosting
   protection, not Knot outcome/content monitoring.

8. Measure the final signed ingress URL from the repository checkout:

   ```powershell
   $env:KNOT_PUBLIC_SLACK_URL='https://YOUR-RENDER-HOST/slack/events'
   $env:KNOT_ACK_CONCURRENCY='1'
   npm run measure:ack
   ```

   Record the JSON result. Before measuring latency, the command requires HTTP
   401 for unsigned, forged-signature, and correctly signed stale-replay
   requests. It then fails if p95 reaches 500 ms, p99 reaches one second, or
   any request reaches Slack's three-second deadline. It is a safe
   cross-workspace rejection probe and does not replace live state-changing
   interactions.
9. In Slack app settings, set **Interactivity & Shortcuts -> Request URL** to
   `https://YOUR-RENDER-HOST/slack/events`. Reinstall only when manifest scopes
   or credentials changed, then verify `slack.json` against the dashboard:
   Agent experience off, Home off, Messages on and read-only, Socket Mode off,
   and exactly the four reviewed bot scopes.
10. Execute every positive, recovery, authorization, replay, rollback, and
   closure path in [SLACK_SETUP.md](SLACK_SETUP.md). Capture Slack screenshots,
   the action and compensation receipts, final audit metadata, and the absence
   of timeout banners.

11. Check Render, Neon, UptimeRobot, `/healthz`, and `/readyz` daily during
    judging and on August 9. Keep the monitor and both provider projects active
    until winners are actually announced. Neon Free has no time limit, so an
    announcement delay no longer creates a forced database migration. Monitor
    the 0.5 GB storage, 100 CU-hour, and 5 GB monthly transfer allowances; this
    low-volume judge sandbox must remain within them.

## Operational checks

- `/healthz` proves the process is serving HTTP; `/readyz` additionally proves
  the database and durable worker are available.
- Render's `/healthz` health check intentionally proves process liveness without
  forcing the Neon Free compute to stay active. `/readyz` remains the database
  and worker gate before tests, demos, and after any availability alert.
- Neon Free compute sleeps after five inactive minutes and resumes on a query in
  a few hundred milliseconds. Slack acknowledgement does not wait for domain or
  database work, but a cold database may make the preparing state last slightly
  longer. Never misreport that work as complete while it is still pending.
- The container runs as the non-root `node` user and includes only production
  dependencies, built output, migrations, entrypoint, and the acknowledgement
  probe. The `npm`/`npx` CLIs are removed after dependency installation because
  the receiver starts directly with `node` and does not need package-management
  tooling in production.
- A failed readiness check must remove the service from traffic. A failed or
  unknown Slack action remains failed or unknown until receipt reconciliation;
  never edit the database to make a demo appear successful.
- Roll back application code by deploying the previous tested image/revision.
  Do not roll back immutable migrations. Use Neon's available time-travel
  restore window only through a tested recovery procedure and record the
  incident.
- The quick Cloudflare tunnel is suitable only for an attended developer
  sandbox test. Its random hostname and local-machine dependency are not stable
  reviewer or production hosting.

## Current distribution boundary

The New Slack Agent hackathon track can be demonstrated from a developer
sandbox. Public/multi-workspace distribution remains blocked until encrypted
installation storage, OAuth installation lifecycle, token rotation, revocation,
uninstall cleanup, and their tenant-isolation tests exist. Do not submit this
Phase-1 installation to Slack Marketplace or install it in customer workspaces.
