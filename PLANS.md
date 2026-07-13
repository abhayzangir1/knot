# Knot delivery plan and gate record

## Status

Architecture is frozen as of 2026-07-12. The active engineering objective is
the live Slack walking skeleton. This plan intentionally makes no feature
commitment beyond the frozen release boundary.

| Phase | Status | Exit evidence |
| --- | --- | --- |
| 0. Pre-skeleton foundation | Complete | AGENTS.md, this plan, architecture, lifecycle, threat model, research, and decision records exist |
| 1. Live Slack walking skeleton | Active | Every required live path and failure case below passes in a Slack developer sandbox |
| 2. Closed-product completion | Blocked by Phase 1 | All released surfaces, four outcome types, Linear, MCP, tenancy, and production hardening pass their documented tests |
| 3. Release verification | Blocked by Phase 2 | Clean install, deployment, security, accessibility, and hackathon-demo evidence are captured |

The current Devpost deadline is July 13, 2026 at 5:00 p.m. PDT. The target is
the New Slack Agent track. Phase 1 alone is not submission-eligible: after its
live evidence is recorded, Knot must actually use and demonstrate at least one
qualifying technology. D-044 selects the already-frozen Knot Core MCP path and
does not permit a mock or unused integration.

## Phase 1: live Slack walking skeleton

The skeleton must work in a real Slack developer sandbox, not only unit tests
or mocked Slack clients:

~~~text
Message shortcut
  -> lightweight preview modal
  -> private outcome creation
  -> private owner acceptance
  -> Check status
  -> deterministic next move
  -> immutable action preview
  -> authorized approval
  -> real reversible Slack action
  -> owner-attested closure evidence
  -> deterministic evidence-metadata and policy validation
~~~

### 2026-07-13 implementation evidence (partial; Phase 1 remains Active)

- Removed automatic `knot-*` private-channel creation. The canonical status
  card is now delivered through the accountable owner's private Knot Messages
  tab; requester and reviewer receive view-only updates, and a different
  next-move owner receives only the role-bound **Prepare progress update**
  control.
- Added a required next-move actor to the Slack contract form and enforced it
  in the deterministic service. The requester cannot prepare an update merely
  by knowing a Slack action value; a shared owner cannot self-approve even
  though their canonical card is a personal DM.
- Private single-message outcomes explicitly self-confirm their own reversible
  update without requesting a reviewer. Shared outcomes still require an
  independent reviewer and named executor.
- The contract modal now exposes every frozen outcome type (Request, Decision,
  Commitment, Handoff, and Other) and passes that selected type into the same
  deterministic closure-evidence policy. This fixes a hidden `request` default;
  it does not add a new type or specialized engine.
- Closure now replaces the canonical owner card with a detailed closed
  projection and sends a detailed summary only to explicit audience principals
  with both `view` and `evidence_access`. Knot retains its audit record rather
  than creating an archive channel or deleting Slack content.
- The manifest removed private-channel create/invite permissions and retains
  `im:history` for two bounded safety reads: version-checking an app-owned DM
  card before rollback, and retry-only reconciliation after an ambiguous
  private-message delivery. First-attempt delivery does not read history. It
  adds `users:read` solely to reject bot, app, deleted, or mismatched members
  from accountable roles before an outcome is created.
- State-changing Slack commands now enter one PostgreSQL-backed, workspace-
  scoped durable queue transaction before acknowledgement. Principal mapping,
  domain writes, Slack calls, and model/connector work occur only in the worker.
  Payload hashes reject dedupe-key collisions; stale leases recover after a
  crash; completed and terminal payloads are redacted.
- The configured bot token is bound at startup to the exact `team_id` returned
  by Slack `auth.test`. Every signed interaction must match that installation
  before it can enqueue work. Retried app DMs reconcile an opaque metadata
  receipt before posting again, while first attempts avoid a history read.
- Automated evidence at the initial durable-queue checkpoint: formatter,
  linter, typecheck, unit, integration, and build gates passed. The complete
  PostgreSQL suite runs through
  `npm run test:postgres` with `TEST_DATABASE_ADMIN_URL`; the runner creates,
  migrates, tests, and always removes a unique database. A real Slack sandbox
  flow using the updated manifest and reinstalled scopes remains mandatory
  before this phase passes.
- Creator confirmation now persists the exact unique set of all eight Outcome
  Contract fields. The owner invitation shows the complete contract, and the
  exact action review shows the target, before/after text, Block Kit hashes,
  plan hash, outcome/contract/policy versions, evidence snapshot, expiry, and
  reversibility before approval.
- A bounded Docker/Render package exists only to host this same Phase-1
  receiver at the stable TLS URL the live Slack test requires. The image uses
  digest-pinned bases, runs as the non-root `node` user, exposes health and
  readiness endpoints, and serializes migrations. Local PostgreSQL is bound to
  loopback; Render is configured for its managed database and `/readyz`. This
  packaging adds no integration, outcome type, or product surface. Both Render
  resources are explicitly Free; the documented cold-start and 30-day database
  limits make this a hackathon sandbox, not always-on production hosting. No
  live Render deployment is claimed until account-side evidence is captured.
- A clean no-cache image build reports zero dependency vulnerabilities. The
  running image is healthy in production mode as the non-root `node` user;
  `/healthz` and `/readyz` both return 200, `.env`, `.git`, source, and tests are
  absent, two simultaneous fresh-database migrators succeed, six migrations
  are recorded, and forced RLS is present on all 15 public data tables. A fresh
  temporary HTTPS tunnel also returns 200 for both endpoints, but Slack's
  dashboard request URL and the complete interaction trace still require live
  verification and are not treated as stable deployment evidence.
- Completed the negative-path recovery surface beside tested services. Owner
  decline now returns a private creator card with **Reassign owner** and
  **Cancel outcome**. Correction reconfirms every contract field and replaces
  the audience atomically; delegation is permission-scoped and retry-idempotent;
  only the creator can delete private outcome content; and only the canonical
  owner closure card can reopen and stale the former closure evidence. Role
  cards do not expose another person's action.
- Current automated evidence after the recovery, authorization, and packaging
  pass: the default release run passes 164 tests with five PostgreSQL-gated
  tests skipped; the isolated PostgreSQL run passes all 169 tests in 20 files.
  Formatter, linter,
  typecheck, build, production and full dependency audits, non-root container
  inspection, local readiness, and the temporary public `/readyz` endpoint all
  pass. The live end-to-end Slack interaction trace is still required and Phase
  1 therefore remains Active.
- A 100-sample signed external acknowledgement probe through the current
  temporary TLS tunnel, run sequentially to model individual Slack
  interactions, recorded p50 252.3 ms, p95 344.7 ms, p99 416.0 ms, and maximum
  550.9 ms. All samples met the release targets. A five-concurrent-request
  stress probe missed the stricter p95/p99 targets while remaining under three
  seconds, so the temporary quick tunnel is not accepted as stable production
  hosting. The probe also requires HTTP 401 for unsigned, forged-signature,
  and correctly signed stale-replay requests before measuring latency; all
  three negative checks pass. The final deployed URL must rerun the same probe.
- After the 2026-07-13 production-image rebuild, a 20-sample sequential
  confirmation probe recorded p50 201.9 ms, p95 271.8 ms, p99 275.7 ms, and
  maximum 275.7 ms; unsigned, forged-signature, and signed stale-replay checks
  again returned HTTP 401. This confirms the rebuilt image, but does not turn
  the temporary quick tunnel into stable hosting or replace the live flow.
- The final 63 MB linux/amd64 image contains 184 indexed packages and Docker
  Scout reports zero critical, high, medium, or low findings. An earlier scan
  found high-severity CVE-2026-12151 only in `undici` bundled by the base
  image's unused global `npm`; D-045 removes that package-management tooling
  from the runtime image without changing the Node receiver.
- Local Compose binds both PostgreSQL and the Knot receiver to loopback. The
  public Slack path is provided only by the explicit TLS tunnel or the stable
  deployment, rather than unintentionally exposing the development receiver
  to every host interface.
- Graceful shutdown stops HTTP ingress first, drains background modal work and
  durable jobs, and closes PostgreSQL last. Every cleanup step is attempted and
  a partial shutdown sets a failing process exit status instead of silently
  skipping later cleanup.
- Startup validates the non-sensitive shape of the Slack signing secret and
  bot token before opening the HTTP receiver, while keeping them optional for
  migration-only processes. Invalid credentials fail without being logged.

The first real action is a Slack update to an app-owned outcome card. The
service stores the exact previous Block Kit payload, sends the approved update,
records Slack's receipt, and proves rollback by restoring the stored payload.
An ownership-request DM is real too, but its withdrawal is a compensating
action: Knot must never claim that a delivered message was unseen.

### Minimum phase-1 components

- Signed Slack HTTP ingress for the message shortcut, modal submission, and
  button actions.
- Durable tenant, actor, ingress-receipt/deduplication, outcome, action-plan,
  execution-receipt, and audit storage.
- A single deterministic application-service layer with identity, policy,
  lifecycle, and action services.
- A minimal transactional outbox/worker boundary for asynchronous domain work.
- Slack card rendering and safe app-owned card updates.
- Tests plus a sandbox script proving the flow and each failure path.

### Phase-1 acceptance criteria

- A valid message shortcut is acknowledged before slow work; a state-changing
  interaction may first commit only its bounded idempotent command receipt in
  one database transaction. Interactions and
  Events API requests have p95 acknowledgement under 500 ms, p99 under one
  second, and no test request exceeds Slack's three-second deadline.
- The creator confirms or edits every Outcome Contract field before a shared
  activation attempt. The proposed owner explicitly accepts before Active.
- Check status returns state, evidenced reason, and one deterministic next move.
- Approval rejects self-approval when the configured default prohibition
  applies, and accepts only an exact, unexpired plan bound to the current
  versions and authorized audience.
- The Slack action executes exactly once despite duplicate clicks/deliveries,
  has a recorded receipt, and rolls back exactly once.
- Closure rejects missing, stale, or unsupported evidence. The phase-1 closure
  records an authorized owner's attestation and validates its metadata; it does
  not claim to verify the external page contents. Closure leaves an auditable
  record.

### Required negative paths

- Owner decline, ownership-request cancellation, and ownership delegation.
- Forged signature, replayed request, malformed payload, duplicate delivery,
  duplicate click, and expired trigger/plan.
- Wrong approver, self-approval, identity mismatch, cross-tenant access, and
  participant-without-audience access.
- Concurrent update/version conflict, stale evidence, failed Slack mutation,
  unknown receipt, compensation, and stale compensation.
- Outcome correction, reopening, and deletion with retained redacted audit
  integrity.

## Hard stop before Phase 1 passes

Do not add any of the following before the full gate passes:

- Additional outcome types or specialized lifecycle logic.
- Linear, any other connector, OAuth beyond Slack installation needs, or
  external webhooks.
- App Home, Agent View enhancements, monitoring, quiet hours, notification
  bundles, or broad graphs/dependencies.
- Knot MCP transport, Slackbot MCP exposure, RTS, Slack-hosted MCP, or generic
  remote-MCP registration.
- Redis, queues beyond the minimal outbox boundary, extra databases, graph
  databases, microservices, or speculative observability infrastructure.

## Phase 2: closed-product completion

Only start after Phase 1 records passing evidence. Complete -- do not partially
expose -- the following release scope:

1. The four named outcome types and Other, each with type-appropriate closure
   validation.
2. Slack DMs, shortcuts, modals, App Home, and Agent View where the workspace
   supports it, with equivalent fallback flows and mobile-safe accessible Block
   Kit.
3. Knot Core Streamable HTTP MCP as a strict, authenticated adapter over the
   application services, with schema validation, origin validation, allowlists,
   actor context, and audit parity.
4. Linear OAuth and signed webhooks, previewed actions, receipts,
   reconciliation, version-checked compensation, and honest degraded state.
5. Multi-workspace OAuth, encrypted credential storage and rotation, RLS,
   inbox/outbox workers, rate limiting, retries/dead letters, tracing, metrics,
   export/deletion, uninstall cleanup, and distribution-scale deployment
   operations. The bounded Docker/Render package used to exercise Phase 1 does
   not satisfy these broader release requirements.
6. Opt-in monitoring, quiet hours, notification controls, delegation, and
   respectful escalation.

Capabilities that an installation cannot certify remain absent from its UI:
Slackbot MCP is optional and capability-gated; RTS and Slack-hosted MCP are
eligible only for installations Slack permits.

## Release gates

The release uses evaluation-policy-v1. It records corpus, evaluator, model,
policy, and threshold versions. A threshold change requires an accepted
decision record.

| Gate | Initial threshold |
| --- | --- |
| Contract extraction precision | At least 95% on versioned annotated fixtures |
| Suggested-outcome false positives | At most 3%; automatic shared activation is forbidden |
| Unsupported critical claims | 0 known violations for approvals, actions, closures, and statements labelled verified |
| Other unsupported factual claims | At most 1%, with evidence, inference, missing-data, conflict, or stale label |
| Authorization and tenant isolation | 0 known bypasses in adversarial tests |
| Duplicate internal effects | 0 known duplicates in concurrency and replay tests |
| Slack action suite | 100% sandbox success with receipt verification and rollback proof |

The zero-violation gates mean known violations block release and the product
fails closed. They do not claim that external systems cannot fail.

## Mandatory release evidence

- Automated lifecycle, evidence, policy, authorization, tenant, concurrency,
  idempotency, Slack ingress, action, compensation, deletion, and accessibility
  test results for the implemented phase. MCP and Linear evidence is required
  only after Phase 1 authorizes those Phase-2 implementations.
- Manual Slack desktop, web, mobile, and screen-reader verification of preview,
  owner acceptance, Check status, approval, action, rollback, and closure.
- A clean Slack sandbox install and the hackathon submission evidence required
  by the current Devpost rules.
- Current platform constraints reviewed in docs/RESEARCH.md and unresolved
  constraints explicitly marked rather than assumed.
