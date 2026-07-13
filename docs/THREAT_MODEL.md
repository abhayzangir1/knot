# Knot threat model

**Status:** frozen baseline for the walking skeleton on 2026-07-12
**Review trigger:** review before any new transport, connector, Slack scope,
model capability, sensitive-data category, or external action class is added.

## 1. Security objective

Knot may coordinate people and perform narrowly authorized Slack or connector
actions. It must protect tenant isolation, identity, audience confidentiality,
approval integrity, action integrity, evidence truthfulness, credential
confidentiality, and audit integrity while minimizing retained Slack content.

Safety is more important than convenience. An uncertain identity, stale plan,
stale evidence, missing authorization, duplicate request, unknown external
result, or conflicting source must fail closed and be visible as such.

## 2. Assets and trust boundaries

| Asset | Security property |
| --- | --- |
| Slack signing secret and OAuth tokens | Confidentiality and rotation |
| Slack raw request and delivery ID | Authenticity, replay resistance, idempotency |
| Tenant/install/identity mappings | Correct tenant and principal binding |
| Outcome Contract, audience grants, evidence references | Confidentiality, integrity, version correctness |
| Action plans, approvals, execution receipts | Integrity, non-repudiation, expiry |
| Connector credentials and external object versions | Confidentiality, scoped access, fresh state |
| Audit events and deletion tombstones | Append-only integrity with privacy-preserving retention |
| Model prompts and outputs | Constrained handling; never authority |

Trust boundaries:

1. Slack -> public HTTPS ingress.
2. Public ingress -> signed/validated transport adapter.
3. Transport adapter -> tenant-scoped application service.
4. Application service -> PostgreSQL, outbox, and encrypted secrets.
5. Worker -> Slack Web API or, after the gate, Linear.
6. Authenticated MCP client -> MCP adapter -> application service.
7. Untrusted human/Slack/model/connector text -> evidence and rendering layer.

## 3. Threats and required controls

| Threat | Required prevention/detection | Fail-safe behavior |
| --- | --- | --- |
| Forged Slack HTTP request | Verify HMAC-SHA256 signature over untouched raw body with constant-time comparison | Reject before parsing/use |
| Replay of valid Slack request | Validate request timestamp, persist idempotent delivery receipt, deduplicate interaction/action IDs | Ack duplicate safely; do not repeat domain/action effect |
| Slack payload or button tampering | Minimal schema validation; opaque server-side references only; reload plan/outcome/policy from tenant store | Reject unknown, expired, mismatched, or stale reference |
| Lost work from fast acknowledgement | One bounded workspace-bound command receipt may precede ack; principal resolution and the durable worker follow | Record recoverable receipt, never a partial domain transition |
| Cross-tenant data access | ActorContext from verified installation, mandatory tenant repositories, RLS, adversarial tests | Deny and audit security event |
| Identity mismatch | Map Slack/connector identities to a tenant principal; require confirmation when mapping is absent/ambiguous | Do not assign, approve, or execute |
| Participant-driven leakage | Participants are separate from audience ACL; authorization checks include evidence visibility | Omit inaccessible content and deny action |
| Privacy-scope confusion | Validate requested scope against explicit audience and Slack surface | Keep private; require corrective confirmation |
| Self-approval/separation-of-duty bypass | Deterministic role evaluation on current plan and actor; versioned policy exceptions only | Reject approval and explain policy reason |
| Stale or altered approval | Bind plan hash, tenant, actor, versions, evidence snapshot, policy version, expiry, and idempotency key | Reject and require fresh preview |
| Duplicate internal effect/race | Unique idempotency key, transaction, optimistic concurrency, outbox deduplication | Return original result or version conflict |
| External duplicate/unknown effect | Provider idempotency when available, receipt capture, reconciliation state | Mark Unknown; never claim success |
| Stale external compensation | Check execution receipt plus current provider version/ETag before counter-action | Stop at ManualResolution |
| Model prompt injection | Treat all text as data; isolate instructions; tool allowlist; strict schemas; deterministic authorization | Refuse tool/action request or ask human to edit |
| Model hallucination/unsupported fact | Evidence labels; field-level references; verified claims require source/receipt; evaluation gate | Mark inferred/missing/conflicting/stale, never verified |
| Overbroad model context | Minimum necessary, audience-filtered evidence; no raw private corpus retention | Omit inaccessible or unneeded content |
| Malicious MCP client/request | Authenticated actor-bound transport, Origin validation, request limits, schema/output validation, tool allowlist | Reject request and audit |
| MCP DNS rebinding/cross-origin access | Validate Origin; authenticate every connection; local service binds localhost | Reject origin/session violation |
| Credential exposure | Envelope encryption, secret redaction, no tokens in URLs/logs, scoped rotation, revocation handling | Revoke/rotate; alert without secret output |
| Linear webhook forgery/replay | Verify raw-body HMAC, timestamp, delivery ID; tenant/object mapping | Reject and avoid mutation |
| Slack/Linear API failure | Retry only idempotent/reconciled work, bounded backoff, dead letters, health signal | Surface degraded/unknown state |
| Audit tampering or deletion conflict | Append-only audit records; redacted/tombstoned content, integrity linkage | Preserve non-sensitive integrity record |
| Notification abuse/disclosure | Private-by-default, audience checks at render, quiet-hour policy after gate, deduplication | Suppress instead of broadcast |
| SSRF/untrusted URLs | Connector/domain allowlists, URL parsing, private-address denial, no arbitrary fetch tools | Reject unsafe URL |
| Denial of service | Request size limits, rate limits, bounded queue, payload validation, timeout budgets | Reject/throttle; preserve core ingress |

## 4. Mandatory security invariants

- The raw Slack request body is preserved until signature verification completes.
  Parse only after a verified signature and fresh timestamp.
- Acknowledgement is immediate; slow work is queued. The receipt-before-ack
  exception is limited to one minimal idempotency record transaction. Internal
  principal resolution and authorization occur in the worker.
- Approval authority is recomputed at execution time from current policy and
  current tenant-scoped records. A button click is never authority.
- A model output, external webhook, or MCP output cannot directly change
  lifecycle state or perform an external action.
- Every write has tenant, actor, correlation, and idempotency context. Every
  consequential write produces an audit event.
- State-changing actions are immutable plans; a plan expires and becomes
  invalid on relevant version, evidence, policy, or audience changes.
- A real external action has a receipt, explicit failure, or Unknown state.
  Knot never substitutes a successful-looking UI for missing confirmation.
- Evidence is audience-filtered before model context, response rendering, MCP
  output, and closure validation.

## 5. Walking-skeleton security test set

The first gate must demonstrate:

1. Valid signed shortcut, modal, and button flows are acknowledged inside the
   budget and result in one durable effect.
2. Forged signature and replayed timestamp are rejected; duplicate valid
   delivery/click creates no duplicate outcome or Slack update.
3. Wrong approver, forbidden self-approver, participant without audience
   access, cross-tenant actor, and identity mismatch cannot view/approve/act.
4. Concurrent edits produce an optimistic-concurrency conflict, not a silent
   overwrite.
5. Expired or stale plan/evidence is rejected. A changed Slack card state
   prevents stale compensation.
6. The real Slack card update receives a receipt, rollback restores the exact
   recorded before state, and a failure/unknown condition remains truthful.
7. Candidate extraction cannot activate a shared outcome until every required
   field has human confirmation and the owner accepts.
8. Correction, reopening, deletion, and audit tombstoning do not reveal
   removed private evidence.

## 6. Residual risk and escalation

Slack delivery, downstream APIs, and humans can fail despite correct Knot
logic. Unknown is a first-class outcome, not an error to conceal. Any suspected
tenant leak, approval bypass, raw-secret exposure, duplicate irreversible
effect, or false verified closure is a release-blocking security incident:
disable the affected action/capability, preserve non-sensitive evidence, and
require a documented remediation before re-enabling it.

Until the walking skeleton passes, Knot has no external connector, no public
MCP endpoint, no App Home/Agent View enhancement, no RTS, no Slack-hosted MCP,
and no generic web retrieval. Those absences reduce the active attack surface;
they are not permission to omit the controls above from the skeleton.
