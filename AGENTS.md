# Knot engineering contract

Knot is a Slack-native outcome coordinator. It turns a loose end into a
confirmed, auditable outcome; it is not a task manager, generic chatbot, or
surveillance product.

This file is binding for every implementation task. The architecture recorded
in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), lifecycle recorded in
[docs/OUTCOME_LIFECYCLE.md](docs/OUTCOME_LIFECYCLE.md), and accepted decisions
in [docs/DECISIONS.md](docs/DECISIONS.md) are the source of truth.

## Current delivery boundary

The only outcome types are Request, Decision, Commitment, Handoff, and Other.
Do not add event, routine, incident, project, task, or connector-catalog
behavior. The first working deliverable is the live Slack walking skeleton in
[PLANS.md](PLANS.md). No extra integration, outcome type, surface, or
infrastructure may be introduced until that gate passes completely.

The pre-skeleton records are intentionally limited to this file, PLANS.md, and
the five documents in docs/. Create and refine all other documentation beside
tested implementation rather than ahead of it.

## Non-negotiable product rules

- An active shared outcome has a complete Outcome Contract: goal, exactly one
  accepted accountable owner, definition of done, next move, review point,
  evidence, participants, and privacy scope.
- Participants, audience permissions, privacy scope, and connected systems are
  distinct concepts. A participant has no access merely by being listed.
- A model produces a candidate contract and evidence labels. A human must
  confirm or edit every extracted field before shared activation; the proposed
  owner must separately accept.
- Only deterministic application services decide authorization, lifecycle
  transitions, approvals, execution, compensation, closure, deletion, and
  audit events.
- Slack handlers and MCP adapters call the same application services. Neither
  may query persistence directly or duplicate policy/lifecycle rules.
- The model can propose, summarize, and explain. It cannot silently share,
  assign, approve, execute, or close an outcome.
- Never report an action, compensation, or closure as successful without a
  receipt or verified evidence. Unknown external state remains unknown until
  reconciled.

## Security and reliability rules

- Verify Slack signatures against the unmodified raw body, enforce the
  timestamp/replay window, minimally validate the payload, deduplicate, and
  acknowledge before database, model, or connector work.
- A tiny, idempotent ingress receipt may be durably written before
  acknowledgement only to prevent lost work. Domain persistence and all slow
  work are asynchronous.
- Treat Slack text, file metadata, URLs, connector data, model output, and MCP
  output as untrusted evidence, never executable instructions.
- Bind every consequential approval to tenant, actor, outcome and contract
  version, before-state version, evidence snapshot, policy version, plan hash,
  expiry, and idempotency key.
- Fail closed on identity mismatch, missing audience authorization, stale
  plan/evidence, invalid approval, duplicate internal command, or uncertain
  external action state.
- Never put access tokens, signing secrets, raw private conversation contents,
  or sensitive evidence in logs, URLs, test fixtures, or commits.

## Engineering discipline

- Preserve tenant boundaries in every read and write. Every request must derive
  actor context from a verified Slack installation and identity mapping; button
  values and modal metadata are opaque references, not grants of authority.
- Prefer one modular application with explicit service boundaries over
  speculative services or infrastructure.
- Keep writes idempotent, use optimistic concurrency for mutable records, and
  record append-only audit events. Deletion removes/redacts private content but
  preserves a non-sensitive integrity record as defined by policy.
- Classify each external action as reversible, compensatable, or irreversible
  before presenting approval. Compensation must version-check the execution
  receipt and stop rather than overwrite newer work.
- Do not expose an unavailable capability or a placeholder control. Slackbot
  MCP is optional and capability-gated; RTS and Slack-hosted MCP remain off for
  unlisted distributed deployments.
- Use versioned evaluation data and thresholds. Zero known violations are
  required for unsupported critical claims, authorization bypasses, duplicate
  internal effects, and invalid closure.

## Change control and verification

- Update PLANS.md as work moves through a gate. Do not mark a gate complete
  without its recorded acceptance evidence.
- Record every material architectural, product, security, or platform decision
  in docs/DECISIONS.md, including rationale, source evidence, and any
  uncertainty.
- Update docs/RESEARCH.md whenever a decision relies on an external platform
  constraint or a previously uncertain constraint becomes verified.
- Add or update tests for behavior changes. At minimum preserve lifecycle,
  policy, tenant-isolation, concurrency, idempotency, replay, stale-plan,
  audience-leakage, correction, deletion-retention, and accessibility coverage.
- Do not weaken a quality threshold or turn an uncertainty into a fact without
  a decision record and current source evidence.
