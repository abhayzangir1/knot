# Phase-1 deployment and live verification

This runbook deploys only the tested Phase-1 Slack receiver. It does not make
the single-workspace, non-rotating installation suitable for Slack Marketplace
distribution; D-035 remains the credential-lifecycle boundary.

## Stable Render deployment

The checked-in Blueprint deliberately requests Render's **Free** instance type
for both the web service and PostgreSQL. This is a zero-cost hackathon sandbox,
not production infrastructure: Render documents that a Free web service spins
down after 15 minutes without inbound traffic and can take about one minute to
wake, while a Free PostgreSQL database is limited to 1 GB, expires after 30
days, and has no backups. Do not upgrade either resource while following this
runbook. If a payment method exists, set the workspace spend limit to zero and
monitor included usage in Render before deployment.

1. Put this exact repository revision in a private GitHub, GitLab, or Bitbucket
   repository. Confirm that `.env`, logs, and credentials are absent from the
   commit and repository history.
2. In Render, create a Blueprint from the repository's root `render.yaml`.
   Keep the web service and PostgreSQL database in one region. The Blueprint
   pins the tested PostgreSQL 17 major version, uses the managed database
   connection string, and exposes no database ingress.
3. Enter `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN` only in Render's secret
   fields. Never put either value in `render.yaml`, a deploy URL, build log, or
   commit. Rotate any credential that has left the trusted local secret store
   before treating the deployment as production evidence.
4. Wait for the Docker build, serialized database migrations, and `/readyz`
   health check to pass. A successful build without a 200 readiness response is
   not a successful deployment.
5. Because the Free web service can sleep, open `/readyz` and wait for HTTP 200
   immediately before every Slack test, reviewer session, or recorded demo.
   A request that wakes a sleeping instance can miss Slack's three-second
   acknowledgement deadline and is not valid latency evidence. Then open both
   endpoints from a separate network path:

   ```text
   https://YOUR-RENDER-HOST/healthz
   https://YOUR-RENDER-HOST/readyz
   ```

6. Measure the final signed ingress URL from the repository checkout:

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
7. In Slack app settings, set **Interactivity & Shortcuts -> Request URL** to
   `https://YOUR-RENDER-HOST/slack/events`. Reinstall only when manifest scopes
   or credentials changed, then verify `slack.json` against the dashboard:
   Agent experience off, Home off, Messages on and read-only, Socket Mode off,
   and exactly the four reviewed bot scopes.
8. Execute every positive, recovery, authorization, replay, rollback, and
   closure path in [SLACK_SETUP.md](SLACK_SETUP.md). Capture Slack screenshots,
   the action and compensation receipts, final audit metadata, and the absence
   of timeout banners.

## Operational checks

- `/healthz` proves the process is serving HTTP; `/readyz` additionally proves
  the database and durable worker are available.
- The Free Render deployment is suitable for the time-bounded hackathon demo,
  but its cold starts, usage limits, database expiry, and lack of backups mean
  it must not be described as always-on or production infrastructure.
- The container runs as the non-root `node` user and includes only production
  dependencies, built output, migrations, entrypoint, and the acknowledgement
  probe. The `npm`/`npx` CLIs are removed after dependency installation because
  the receiver starts directly with `node` and does not need package-management
  tooling in production.
- A failed readiness check must remove the service from traffic. A failed or
  unknown Slack action remains failed or unknown until receipt reconciliation;
  never edit the database to make a demo appear successful.
- Roll back application code by deploying the previous tested image/revision.
  Do not roll back immutable migrations. Restore data only from the managed
  database recovery mechanism and record the incident.
- The quick Cloudflare tunnel is suitable only for an attended developer
  sandbox test. Its random hostname and local-machine dependency are not stable
  reviewer or production hosting.

## Current distribution boundary

The New Slack Agent hackathon track can be demonstrated from a developer
sandbox. Public/multi-workspace distribution remains blocked until encrypted
installation storage, OAuth installation lifecycle, token rotation, revocation,
uninstall cleanup, and their tenant-isolation tests exist. Do not submit this
Phase-1 installation to Slack Marketplace or install it in customer workspaces.
