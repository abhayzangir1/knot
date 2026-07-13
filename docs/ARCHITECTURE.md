# Knot architecture

**Status:** frozen for the live-Slack walking skeleton on 2026-07-12
**Authority:** This document is binding with AGENTS.md, PLANS.md,
OUTCOME_LIFECYCLE.md, THREAT_MODEL.md, and DECISIONS.md.

## 1. Purpose and boundary

Knot coordinates outcomes inside Slack. It makes ownership, evidence, the next
move, authorization, and closure explicit. It is not a generalized task
manager, autonomous executor, generic chat assistant, surveillance tool, or
connector marketplace.

The release domain is deliberately closed:

- Request
- Decision
- Commitment
- Handoff
- Other, as a generic fallback

There is one accountable owner per outcome. Contributors, delegates,
requesters, beneficiaries, decision participants, and other type-specific
participants may also be recorded, but do not replace ownership.

No specialized event, routine, incident, project, milestone, or task engine is
part of this architecture.

## 2. Authoritative system shape

~~~text
Verified Slack interaction               Authenticated MCP request
            |                                      |
            v                                      v
    Slack transport adapter                  MCP transport adapter
            \                                      /
             \                                    /
              v                                  v
       Actor-context and request boundary (no domain authority)
                             |
                             v
      Deterministic application services and policy services
                             |
              +--------------+---------------+
              |                              |
              v                              v
    Tenant-scoped repositories       Transactional inbox/outbox
              |                              |
              v                              v
      PostgreSQL records             Slack / connector delivery workers
                                             |
                                             v
                                  Slack Web API; later Linear API
~~~

Application services are the sole source of truth for contract validation,
lifecycle transitions, permissions, approval, execution, compensation,
closure, correction, deletion, and audit records.

The Slack and MCP adapters are deliberately thin:

- They authenticate and minimally validate a transport request.
- They build an ActorContext and correlation metadata.
- They invoke an application service.
- They never access repositories directly and never reproduce business,
  policy, approval, or lifecycle logic.

The model is an untrusted, constrained collaborator. It can produce a
candidate contract, extraction, summary, explanation, or proposed next move.
It cannot gain authority by its output and cannot invoke persistence or
external actions except through an authorized service command.

## 3. Slack ingress and asynchronous work

Slack ingress has a short, safety-critical synchronous boundary:

1. Retain the raw body for signature verification.
2. Verify the Slack signature and timestamp/replay window.
3. Check route and minimal payload shape; do not trust embedded user, team, or
   action metadata as authority.
4. Require the signed payload's Slack team ID to match the installation team
   authenticated by the configured bot token at startup, then derive an
   idempotency delivery key.
5. For a state-changing interaction, persist only a bounded, workspace-bound,
   idempotent command receipt in one database transaction. Do not resolve or
   create the internal principal on this synchronous path.
6. Acknowledge immediately. For a message shortcut, acknowledge and open the lightweight
   Preparing outcome modal while the one-time trigger remains valid.
7. The worker resolves ActorContext, revalidates tenant and authority, and then
   performs domain persistence or Slack work. Subsequent UI updates are
   rendered from durable state.

The command receipt is not an outcome write and cannot change outcome state.
Only its single bounded transaction may precede acknowledgement. Principal
mapping, domain/repository work, model calls, Slack API calls other than the
immediate post-ack modal open, and connector operations may not delay the
acknowledgement. The target is p95 below 500 ms, p99 below one second, and no
request above Slack's three-second deadline.

## 4. Identity, tenancy, and access model

Every command has an immutable ActorContext produced from verified transport
data:

| Value | Source and meaning |
| --- | --- |
| tenant/workspace | Verified Slack installation and team/enterprise relationship |
| Slack actor | Verified Slack user ID from the signed payload or authenticated MCP identity |
| internal principal | Tenant-scoped identity mapping, never a string supplied by a button or model |
| installation | Tenant installation record and granted scopes |
| request context | Correlation ID, ingress/delivery ID, route, timestamp, and policy version |

An opaque value in a Slack button or modal may identify a server-side action
plan but never authorizes it. A service reloads the plan, outcome, audience,
and policy from the tenant-scoped store and makes the authorization decision
again.

The following are separate records and must not be conflated:

| Concept | What it means | What it does not mean |
| --- | --- | --- |
| Participant | A role in the outcome, such as contributor, delegate, requester, beneficiary, or decision participant | Permission to view, edit, approve, or see evidence |
| Authorized audience | Explicit ACL grant for view, edit, approve, or evidence access | The outcome's purpose or default visibility |
| Privacy scope | Default disclosure intent: private, selected people, channel, workspace, or connected system | An ACL by itself |
| Connected system | System identity, external object reference, connector health, granted permissions, and execution receipts | A Slack privacy scope or participant |

Tenant context is mandatory for all repository operations. PostgreSQL
row-level security and repository scoping are defense in depth; neither may
substitute for service-level authorization.

## 5. Outcome Contract and core records

An active shared outcome must have a complete, versioned Outcome Contract:

| Field | Required production invariant |
| --- | --- |
| Goal | A plain-language result, not a list of activity |
| Accountable owner | Exactly one principal who explicitly accepted |
| Definition of done | Observable completion criteria appropriate to the type |
| Next move | Exactly one current action and its actor |
| Review point | A time or explicit event trigger |
| Evidence | Accessible references; closure requires supporting evidence |
| Participants | Role-bearing people affected, contributing, benefiting, or deciding |
| Privacy scope | The intended default disclosure scope |

Logical records required by the architecture:

- Tenant, installation, and identity mapping.
- Outcome, versioned Outcome Contract, participants, audience grants, and
  evidence references.
- Connected system, connector authorization, external object mapping, health,
  and external version/ETag where supplied.
- Action plan, approval decision, execution receipt, compensation attempt, and
  reconciliation result.
- Ingress receipt, idempotency key, outbox item, delivery result, and
  append-only audit event.

Source content is stored only to the minimum necessary extent. Evidence
records preferentially retain a reference, visibility classification,
freshness, and integrity metadata rather than raw private conversation text.

## 6. Policy and action architecture

The policy service deterministically enforces:

- Who may create, edit, share, activate, accept ownership, transfer ownership,
  delegate, view evidence, approve, execute, correct, reopen, close, or delete
  an outcome.
- Type-specific authority and closure requirements.
- Audience and privacy-scope compatibility before any shared operation.
- Separation of duties and configurable self-approval restrictions.
- Exact-plan approval binding: tenant, actor, outcome/contract version,
  before-state version, evidence snapshot, policy version, plan hash, expiry,
  and idempotency key.

The default policy denies self-approval of a consequential shared action when
the actor is the requester, executor, accountable owner, or sole beneficiary.
A personal reversible action may be self-confirmed only under an explicit,
versioned policy exception recorded in audit history.

Action plans are immutable after creation. Before approval, every external
effect is classified:

| Classification | Rule |
| --- | --- |
| Reversible | The exact before state and a verified restore operation exist |
| Compensatable | A defined counter-action exists but cannot erase all prior effects |
| Irreversible | No safe undo exists; this is visible before approval |

Execution state is separate from outcome state:

~~~text
planned -> approved -> dispatching -> applied
                                  -> failed
                                  -> unknown
                      -> compensating -> compensated
                                        -> manual-resolution
~~~

Internal commands use a unique idempotency key. External effects use provider
idempotency where available; otherwise the result becomes unknown until
reconciled. A compensation operation must check the execution receipt and
current external version/ETag. If changed, it stops with manual-resolution and
never overwrites newer work.

## 7. Walking-skeleton architecture

Only the following capability is built before the first gate:

~~~text
Message shortcut -> preview -> private proposed outcome
-> owner request/acceptance -> role-specific private outcome card -> Check status
-> next move -> action plan -> authorized approval -> chat.update
-> receipt -> owner attestation plus deterministic closure validation -> rollback proof
~~~

The initial real action is chat.update on an app-owned outcome card. Its stored
prior Block Kit payload enables exact rollback. An owner-request DM is also a
live Slack action, but deleting or withdrawing it is compensation rather than
undo because a person may already have seen it.

No Linear request, model-backed shared activation, MCP endpoint, App Home,
Agent View enhancement, RTS, Slack-hosted MCP, broad monitoring, connector
menu, or additional outcome type is required or allowed before this gate is
passed.

## 8. Completion-stage adapters

After the walking skeleton passes, the architecture admits only the following
adapters:

- **Knot Core MCP:** a secure Streamable HTTP endpoint that authenticates the
  caller, validates Origin and schemas, derives ActorContext, calls the same
  application services, and returns validated data. It does not own logic or
  repositories.
- **Slackbot MCP:** an optional capability-gated client path to Knot Core. It
  is not a release blocker and is absent from a workspace that cannot certify
  availability and authorization.
- **Linear:** a specific, authenticated connector with encrypted credentials,
  signed webhook ingress, object/version mapping, action receipts,
  reconciliation, and compensation rules.
- **Slack UI:** DMs, shortcuts, modals, App Home, and Agent View where
  available. All critical outcome work has an equivalent supported Slack path;
  no unavailable capability creates a dead end.

RTS and Slack's hosted MCP server are not dependencies. They may be used only
by a deployment eligible under Slack's current distribution restrictions and
after a separately recorded capability check.

## 9. Explicit exclusions

This architecture excludes arbitrary remote MCP registration, model-owned
execution, direct model database access, unbounded web retrieval, background
analysis of private Slack conversations, employee scoring, behavior ranking,
surveillance analytics, raw RTS retention, and any service introduced solely
for architectural polish.
