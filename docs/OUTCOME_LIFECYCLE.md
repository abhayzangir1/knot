# Knot outcome lifecycle

**Status:** frozen lifecycle contract on 2026-07-12
**Authority:** Lifecycle transitions are implemented only by deterministic
application services. This record defines the behavioral contract, not a UI
workflow.

## 1. Outcome types and ownership

Knot supports exactly five types:

| Type | Minimum closure proof |
| --- | --- |
| Request | The requested result was delivered, answered, or explicitly declined, with evidence that satisfies the definition of done |
| Decision | An authorized decision is recorded and available to its authorized audience, with evidence of the decision and required acknowledgement |
| Commitment | The committed result is verified, or an authorized renegotiation/decline is recorded against the definition of done |
| Handoff | The receiving accountable owner accepts, required artifacts/evidence are accessible to the authorized audience, and the definition of done is met |
| Other | The creator supplies observable definition-of-done criteria and supporting closure evidence |

Every outcome has exactly one accountable owner. The owner is a named
principal, not a role label. Other participant roles may include contributor,
delegate, requester, beneficiary, decision participant, or a type-specific
role. Participants do not receive access implicitly.

A delegate may perform an authorized action for an owner, but ownership remains
with the accepted owner until an authorized ownership-transfer transaction
succeeds.

## 2. Outcome Contract

The contract is versioned. A shared Active outcome requires all fields below:

| Field | Validation rule |
| --- | --- |
| Goal | Plain-language desired result |
| Accountable owner | Exactly one explicitly accepting principal |
| Definition of done | Observable, type-appropriate completion criteria |
| Next move | One current action and its actor |
| Review point | A timestamp or explicit event trigger |
| Evidence | Accessible source references with freshness/status labels |
| Participants | People and relationship roles, separately recorded from permissions |
| Privacy scope | Private, selected people, channel, workspace, or connected-system intent |

The authorized audience is an explicit access-control list, not an Outcome
Contract field and not inferred from participants or privacy scope. Connected
systems are separate records.

Model extraction creates a candidate contract. Every extracted field,
participants, and privacy scope must be explicitly confirmed or edited by the
creator before shared activation. The proposed owner must accept separately.

## 3. Outcome states

~~~text
Draft (ephemeral UI only)
  -> Proposed
  -> Clarified
  -> AwaitingOwnerAcceptance
  -> Active
  -> Waiting | AtRisk | Blocked
  -> ClosureRequested
  -> ClosedVerified

Active/Waiting/AtRisk/Blocked/ClosedVerified
  -> Corrected (new version; returns to appropriate non-terminal state)
  -> Reopened (from ClosedVerified when closure evidence is invalidated)
  -> Superseded (linked successor owns future coordination)

Proposed/Clarified/AwaitingOwnerAcceptance/Active/Waiting/AtRisk/Blocked
  -> Cancelled
~~~

State meanings:

| State | Meaning and permitted exit |
| --- | --- |
| Proposed | Private outcome exists; contract may be incomplete; creator can edit, cancel, or request ownership |
| Clarified | Creator is resolving missing/contradictory contract fields or recovering a declined owner request; cannot activate, escalate, execute a shared action, or close |
| AwaitingOwnerAcceptance | Creator confirmed a complete candidate contract and sent an owner request; the owner can accept, decline, or propose a change |
| Active | Full contract, accepted owner, valid audience/visibility, and one next move exist |
| Waiting | Active but pending a declared external/person/event dependency; review point remains mandatory |
| AtRisk | Active and evidence/rules indicate a credible risk to definition of done or review point; cannot be set from an incomplete contract |
| Blocked | Active work cannot proceed; blocker evidence and next review/next move are required |
| ClosureRequested | An authorized actor submitted closure evidence; deterministic verification is pending |
| ClosedVerified | Type-specific definition of done, authority, and evidence metadata pass deterministic validation; closure is auditable. This does not imply Knot inspected an external evidence page. |
| Corrected | An event/version marker, not a durable substitute for the state; a correction produces a new contract/evidence version and restores a valid working state |
| Reopened | A previous ClosedVerified outcome returned to a valid working state because evidence, authority, or outcome facts changed |
| Superseded | This outcome remains readable/auditable but routes new coordination to a linked successor |
| Cancelled | Coordination stopped without claiming completion; cancellation reason is auditable |

The skeleton must implement Proposed, AwaitingOwnerAcceptance, Active,
ClosureRequested, ClosedVerified, Cancelled, correction/versioning, and
reopening behavior required by its tests. Waiting, AtRisk, Blocked, and
Superseded are reserved lifecycle states for closed-product completion; they
must not appear as half-built controls before their full behavior is delivered.

`ClosedVerified` is the lifecycle concept recorded by the architecture. The
current persisted runtime value is `closed`; user-facing closure copy must
describe exactly what Knot validated and must not overstate external evidence.

## 4. Activation invariant

An outcome may transition to Active only when all conditions are true:

1. The complete contract validates.
2. Every model-extracted contract field has creator confirmation/edit evidence.
3. The proposed owner has explicitly accepted.
4. The actor is authorized to choose the privacy scope and audience.
5. All participants and audience grants are valid tenant principals or
   intentionally unresolved placeholders that receive no access.
6. The current contract/evidence versions have not changed during validation.
7. A deterministic policy check allows the transition.

An incomplete, stale, contradictory, or unauthorized outcome must remain
non-active and explain what is missing without claiming completion.

When a proposed owner declines, the outcome returns to Clarified. Because the
declined proposal never became accountable ownership, recovery is a
creator-authorized reassignment rather than an ownership transfer. The creator
must submit a different proposed owner in a complete, reconfirmed contract and
authorized audience; this creates a new contract version, resets acceptance to
Pending, and returns the outcome to AwaitingOwnerAcceptance. The new proposed
owner must accept separately before activation.

The Slack recovery card exposes exactly two creator actions after decline:
reconfirm and request a different owner, or cancel without claiming completion.
The old proposed owner receives no reassignment authority. A successfully
reassigned request creates a new private invitation and replaces the canonical
owner-card reference; retrying the same durable command does not create another
domain transition.

## 5. Check status and next-move invariant

Check status returns:

1. Current lifecycle state.
2. One evidence-backed reason for that state.
3. One deterministic next move and its actor.

Evidence is labeled verified, inferred, missing, conflicting, or stale.
Knot does not elevate an inference to a verified fact. A next move may be
proposed by a model but becomes actionable only after deterministic validation
and, where applicable, an action plan/approval.

## 6. Action and approval lifecycle

Actions are separate from outcomes:

~~~text
Planned -> Approved -> Dispatching -> Applied
                                  -> Failed
                                  -> Unknown
                      -> Compensating -> Compensated
                                        -> ManualResolution
~~~

Before approval, an immutable action plan contains recipients, before/after
state, action classification, required approvers, exact outcome/contract and
evidence versions, policy version, plan hash, expiry, idempotency key, and
defined compensation when applicable.

Approval is invalid when any binding value is stale, the actor lacks audience
or policy authority, self-approval is forbidden, the plan expired, or the
request is duplicate. An applied action never auto-closes an outcome.

The walking-skeleton action is a reversible update to an app-owned Slack card.
The before payload is retained, Slack receipt is stored, and rollback restores
the precise before payload. A message that a person already received is
compensatable at most, not reversible.

## 7. Closure, correction, and deletion

Closure requires all of the following:

- An active, complete contract (unless an authorized cancellation path applies).
- Definition-of-done validation for the type.
- Supporting, accessible, non-stale evidence.
- Authorized actor and audience checks.
- A deterministic policy result.

If evidence conflicts or becomes stale, Knot refuses closure and
records the reason. A later correction creates a new immutable version with a
reason and actor. Reopening preserves the original closure event and requires
a new path through deterministic closure validation.

A correction requires the editing actor to reconfirm all eight shared-contract
fields. The application service replaces the contract, provenance, and
authorized audience atomically, preserves the accepted accountable owner, and
invalidates approvals bound to an earlier outcome or contract version. Changing
the owner or outcome type is not a correction.

An owner may grant a bounded, optionally expiring delegation. The delegate is
added as a participant and explicit audience principal, but accountability does
not transfer. Slack renders only the controls represented by the active stored
delegation, and every click is re-authorized by the application service.

Deletion removes or redacts private source content and revokes access. It does
not falsify history: a minimum, non-sensitive audit tombstone retains the
event type, tenant, actor/pseudonymous reference as policy permits, timestamp,
and integrity linkage. Deleted evidence is never served through Check status,
audience views, MCP, or a connector.

Only the outcome creator, or a workspace administrator who already has explicit
audience edit authorization, may delete. The accountable owner, next-move
actor, reviewer, or edit delegate does not gain deletion authority merely from
their outcome role. The Slack deletion receipt contains no deleted goal or
evidence text.
