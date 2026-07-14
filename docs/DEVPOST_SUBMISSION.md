# Knot future submission template (unsubmitted)

> **Historical status:** This material was not fully submitted before the Slack
> Agent Builder Challenge deadline. It is retained only as a future submission
> template. Present-tense passages about a complete live flow, Knot Core MCP,
> Slackbot tool calls, video evidence, and receipts describe the intended
> target, not functionality verified in the frozen snapshot. Do not publish or
> quote this copy until every gate below passes and the text is revalidated
> against the implementation. See [CONTINUATION_GUIDE.md](CONTINUATION_GUIDE.md)
> for the current, accurate handoff.

This template targets a future **New Slack Agent** submission. A working use of
Slack AI, MCP, or RTS is mandatory; configured UI or a planned integration is
not enough.

## Final submission gate

- [ ] The shared live path completes approval, execution receipt, rollback,
  closure, and reopen.
- [ ] The live negative role check proves that an unauthorized account cannot
  approve or execute.
- [ ] Knot Core MCP is deployed and Slackbot invokes the real read-only status
  tool using Slack identity authentication.
- [ ] The MCP response matches the current deterministic outcome state and its
  tool confirmation is visible in Slack.
- [ ] `npm run check`, PostgreSQL tests, deployment readiness, and the signed
  acknowledgement probe pass after the MCP change.
- [ ] Both judge accounts appear as accepted members of the sandbox.
- [ ] The final public video URL is inserted and works while signed out.
- [ ] The Devpost preview contains the architecture PNG, sandbox URL, source
  link, and no secrets or unsupported claims.

## Submission facts

| Devpost field | Paste or select |
| --- | --- |
| Project name | Knot |
| Tagline | Tie up every loose end in Slack—without surrendering control. |
| Track | New Slack Agent |
| Submission language | English |
| Source code | https://github.com/abhayzangir1/knot |
| Slack developer sandbox | https://app.slack.com/client/T0BGX67AAN8 |
| Architecture diagram | Upload `docs/architecture.png` |
| Demo video | `PASTE_FINAL_PUBLIC_VIDEO_URL_HERE` |
| Slack App ID | A0BGM9MUDS7 (retain for testing notes; not required for this track) |

## One-line summary

Knot turns a Slack message into an owner-accepted, evidence-backed outcome with
role-separated approval, reversible execution, and auditable closure.

## Short description

Knot is a Slack-native outcome coordinator for the work that normally falls
between chat and task management. From one message, it creates a complete
Outcome Contract, obtains explicit owner acceptance, gives each participant
only the controls their role permits, previews an exact Slack update, separates
approval from execution, records the result, proves rollback, and refuses to
close without owner-attested evidence. Slackbot can query the same deterministic
application services through Knot Core MCP; MCP is an authenticated adapter,
not a second source of business logic.

## Project story

### Inspiration

Important work often begins as a sentence in Slack: “Can someone send this?”,
“We decided to ship Friday”, or “Please hand this over.” The message is visible,
but accountability, completion evidence, and the next move remain implicit.
Traditional task tools solve this by asking people to leave the conversation
and maintain another list. Generic AI assistants can summarize the message, but
they can also blur who agreed, who is authorized, and whether anything actually
happened.

Knot starts from a different question: what is the smallest contract required
to turn a loose end into a safely completed shared outcome?

### What it does

From the **Tie it up with Knot** message shortcut, the creator confirms every
field of an Outcome Contract: outcome type, goal, accountable owner, definition
of done, next move and actor, review point, source evidence, participants, and
privacy scope. A proposed owner must separately accept before the outcome can
become Active.

Knot then sends private, role-specific cards in Slack. The accountable owner can
check status, correct the contract, delegate bounded authority, and submit
closure evidence. Only the named next-move actor can prepare a progress update.
For a shared outcome, only the independent reviewer can approve the immutable
before-and-after plan, and only the named executor can run it. Button payloads
are opaque references; every action is re-authorized by deterministic policy.

The walking skeleton performs a real `chat.update` on an app-owned Slack card.
Knot records the exact before and after payloads plus Slack’s receipt, then
restores the previous card only if the current Slack version still matches.
Closure is separate from action success: the accountable owner supplies an
accessible evidence reference, and Knot validates authorization, freshness,
type, metadata, and audience access without pretending to inspect or verify the
external page’s contents.

Knot Core MCP exposes the same application services to Slackbot through strict,
actor-bound tools. In the demo, Slackbot retrieves the current outcome status,
owner, next move, and evidence state. The tool cannot bypass tenant, audience,
or lifecycle policy, and MCP contains no duplicate business logic.

### How we built it

Knot is a modular TypeScript application using Slack Bolt, the Slack Web API,
Block Kit, PostgreSQL, Drizzle ORM, and an authenticated Streamable HTTP MCP
adapter. Slack signatures are verified against the raw body, timestamps are
replay-checked, and state-changing interactions write only a bounded,
idempotent command receipt before acknowledgement. Domain work and Slack calls
run asynchronously through a durable worker.

Every read and write is workspace-scoped. Actor context comes from the verified
Slack installation and mapped Slack identity. Mutable records use optimistic
concurrency; commands use idempotency keys; audits are append-only; and private
deletion keeps only a redacted integrity tombstone. Consequential approval is
bound to the tenant, actor, outcome and contract version, before-state version,
evidence snapshot, policy version, plan hash, expiry, and idempotency key.

The sandbox runs on a Render Free web service backed by Neon PostgreSQL. The
repository’s current verification gate runs formatting, lint, type checking,
173 automated tests, and a production build. Separate integration tests cover
PostgreSQL tenant isolation, durable queues, concurrency, replay,
idempotency, compensation, evidence, deletion retention, and RLS.

### Challenges

The hardest problem was not generating text; it was preserving human authority
across Slack’s asynchronous interaction model. Slack requires fast
acknowledgement, while persistence, policy checks, network calls, and recovery
must remain durable. Knot therefore separates a minimal pre-ack ingress receipt
from asynchronous domain work and coalesces repeated status requests without
hiding changed state.

Another challenge was making safety visible without making the experience feel
like a compliance form. The modal uses least-privilege defaults, plain-language
labels, explicit evidence confirmation, and role-specific cards. The UI never
shows a control merely because someone can see an outcome.

### Accomplishments we are proud of

- One Slack-native path covers creation, owner acceptance, deterministic next
  move, exact-plan approval, real reversible execution, receipt verification,
  closure evidence, and reopen.
- Shared outcomes enforce separation of duties; personal outcomes use a narrow,
  explicit self-confirmation exception.
- Replays, duplicate clicks, concurrent updates, stale approvals, stale
  rollback, identity mismatch, and cross-tenant access fail closed.
- Knot creates no channel per outcome and never exposes a placeholder control.
- MCP and Slack interactions call the same deterministic application services;
  the model can explain and propose, but it cannot silently assign, approve,
  execute, share, or close.

### What we learned

Agentic UX is strongest when intelligence and authority are separated. A model
can help a person understand the state, but reliable collaboration needs exact
contracts, explicit ownership, deterministic policy, receipts, evidence, and
honest unknown states. Slack is particularly well suited to this because the
conversation, identities, approvals, and visible result can stay in one place.

### What is next

The immediate commitment is operational: keep the submitted sandbox and its
data available throughout judging, monitor only infrastructure health, and
respond to any reproducible judge-access issue. Product expansion remains
subject to the same evidence, privacy, and authorization gates demonstrated in
this submission.

## Built with

Paste these as technology tags where Devpost permits:

`Slack` · `Slack Bolt` · `Slack Web API` · `Block Kit` · `MCP` · `TypeScript` ·
`Node.js` · `PostgreSQL` · `Drizzle ORM` · `Zod` · `Vitest` · `Render` · `Neon`

## Judge testing instructions

Use the following as the private testing instructions:

> Open the Slack developer sandbox at
> https://app.slack.com/client/T0BGX67AAN8 using the invited judge account.
> Open **Knot** under **Agents & apps** and confirm that its Messages tab loads.
>
> For a self-contained personal test, post this message in a channel you can
> access: **Please publish the final Knot demo today and record a public receipt.**
> Open the message’s **More actions** menu and select **Tie it up with Knot**.
> Choose Request, choose yourself as both accountable owner and next-move actor,
> leave the independent reviewer empty, enter an observable definition of done
> and next move, choose a review point, open and confirm the source message, and
> keep visibility at **Only me**. Submit the contract, then accept ownership in
> Knot Messages.
>
> Use **Prepare progress update**, inspect the exact before-and-after preview,
> explicitly self-confirm the personal reversible action, and execute it. The
> app-owned card will change and show a verified Slack receipt. Use **Restore
> previous card** to prove version-checked rollback. Only the owner can submit
> closure evidence or reopen the outcome.
>
> For the shared separation-of-duty example shown in the demo, the sandbox has
> distinct creator, owner, next-move actor, and reviewer accounts. Knot’s
> private cards expose different controls to each role. An unauthorized role
> cannot approve or execute even if an action payload is replayed.
>
> In Slackbot, use this exact prompt to exercise the real Knot Core MCP tool:
> **Use Knot to check the current status of my visible outcome about submitting
> Knot. Return its accountable owner, deterministic next move, and evidence
> status. Do not create, approve, execute, or close anything.** Confirm the tool
> request when Slack asks. The result is read-only and audience-filtered.
>
> Source: https://github.com/abhayzangir1/knot

## Public video metadata

### Video title

Knot — Tie up every loose end safely in Slack | Slack Agent Builder Challenge

### Video description

Knot turns one Slack message into an owner-accepted, evidence-backed outcome.
This demo shows a complete Outcome Contract, role-separated controls, an
immutable approval plan, a real reversible Slack update, receipt-backed
rollback, evidence-based closure, and a real Slackbot-to-Knot MCP status query.

Source: https://github.com/abhayzangir1/knot

Built for the Slack Agent Builder Challenge — New Slack Agent track.

### Suggested tags

`Slack` `SlackDev` `MCP` `AI agent` `agentic workflow` `TypeScript`

### Thumbnail text

**KNOT**<br>
**From loose end to verified outcome**

## Final Devpost review

Before clicking **Submit**, verify all of the following in the Devpost preview:

1. Track is **New Slack Agent**, not Organizations.
2. Video duration is below three minutes and the link works signed out.
3. The video visibly shows the working Slack project and the real MCP call.
4. `architecture.png` is legible at full size.
5. Sandbox and source URLs are clickable.
6. Both judge accounts have accepted sandbox access.
7. No token, signing secret, database URL, private message, browser password,
   Render environment value, or sensitive evidence appears anywhere.
8. Submit before the deadline and save a screenshot of Devpost’s acceptance
   receipt plus the public project URL.
