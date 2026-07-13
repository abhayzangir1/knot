# Slack setup for the walking skeleton

## Import the manifest

Create or update the Slack app from [slack.json](../slack.json). The reviewed
hackathon manifest uses this stable public TLS receiver:

```text
https://knot-1pc1.onrender.com/slack/events
```

The manifest intentionally requests only the scopes used by the skeleton:
`chat:write`, `im:write`, `im:history`, and `users:read`. Knot uses `im:history`
for two bounded safety reads: comparing the current app-owned direct-message
card before rollback, and scanning recent opaque message metadata only after an
ambiguous private-message delivery retry. First-attempt delivery does not read
history. If the rollback comparison is unavailable or does not match, Knot
stops rather than overwriting the Slack message. It uses `users:read` only to
reject Slackbot, app users, deleted members, and identity mismatches in
accountable roles; it does not request email access. Knot does not create,
invite people to, archive, or delete outcome channels.

Install or reinstall the app after changing scopes. A request-URL-only change
does not grant a new scope, but it must still be saved and tested. Put the
generated signing secret and bot token only in approved secret stores such as
local `.env` and the Render environment.

The Phase-1 manifest deliberately has token rotation disabled because this
receiver supports one controlled developer-workspace installation and no OAuth
refresh-token store. Do not distribute this installation. Public or
multi-workspace use is blocked until the rotation/reinstall lifecycle in D-035
is designed, implemented, and tested.

Keep **Agent experience** off for the Phase-1 walking skeleton. Keep the Home
tab off, the Messages tab on, and the Messages tab read-only. The current
receiver does not subscribe to conversational `message.im` events and exposes
no chat composer; enabling an agent surface now would create a dead control.

## Exercise the live gate

Use at least three test users for a shared outcome:

1. In a Slack message, use **More actions -> Tie it up with Knot**.
2. Confirm every contract field, choose the outcome type, choose an owner, a
   next-move owner, and an independent reviewer.
3. The owner accepts the private invitation.
4. The owner receives the canonical status card in their private Knot Messages
   tab. They can **Check status**, **Submit closure evidence**, submit a
   versioned correction, and delegate a bounded permission set. If the owner is
   also the creator, they can delete private outcome content; otherwise only
   the creator sees deletion. If another person was selected for the next move,
   only that person receives **Prepare progress update**; otherwise it appears
   on the owner's card.
5. The next-move owner prepares the update. The independent reviewer opens
   **Review exact update** and approves that immutable preview.
6. The named executor uses **Execute approved update**.
7. Verify that the canonical app-owned card changed, then use **Restore
   previous card**. Change the card manually before trying another restore to
   confirm Knot refuses a stale rollback.
8. Add an accessible HTTPS completion reference through **Submit closure
   evidence**. Knot records it as owner-attested evidence, validates authority,
   type, freshness, and reference metadata, and privately sends the detailed
   closure summary only to people with evidence access. It does not claim to
   inspect or independently verify the linked page contents.
9. Confirm that only the accountable owner's closure card exposes **Reopen
   outcome**, and that reopening returns the outcome to Active while making the
   old closure evidence stale.

Exercise the recovery and authorization paths before recording the gate:

- Decline the ownership request. Only the creator must receive **Reassign
  owner** and **Cancel outcome**. Reassignment must reopen a complete contract
  confirmation and the replacement owner must separately accept.
- Correct an active outcome. Every contract field, participants, privacy scope,
  and audience selection must be reconfirmed; a type change must be rejected in
  favor of creating a new outcome.
- Delegate one permission, verify that the delegate receives only the matching
  controls, and verify that accountability remains with the owner. Attempt an
  ungranted action and confirm that the service rejects it even if a button
  value is replayed.
- From the creator's card, delete an outcome after Slack's irreversible-action
  confirmation. All recipients must receive only a generic deletion receipt;
  deleted goal and evidence text must not be re-posted. An owner who is not the
  creator must not see or be able to invoke deletion.
- Replay an acceptance, update, approval, execution, compensation, correction,
  delegation, deletion, and reopen interaction. Each must produce one internal
  effect and an honest current-state response rather than a duplicate effect.

The visible control matrix is deliberately narrower than audience access:

| Recipient | Controls |
| --- | --- |
| Creator/requester | Check status, Correct outcome, Delete private content |
| Accountable owner | Check status, Prepare progress update only when named for the next move, Submit closure evidence, Correct outcome, Delegate authority; Delete only when also creator |
| Different next-move actor | Prepare progress update; creator management controls only when this person is also the creator |
| Independent reviewer | Check status until an exact plan exists, then Review exact update |
| Named executor | Execute approved update only after a valid exact-plan approval |
| Delegate | Check status plus only the active delegated permissions |
| Other authorized viewer | Check status only |

For a private outcome created from a single message, choose yourself as owner
and **Only me** visibility. Knot still asks for explicit ownership acceptance,
then lets you inspect the exact reversible update and self-confirm it. It never
asks a reviewer to approve a personal outcome.

Slack validates the receiver signature before Bolt invokes a handler. Every
state-changing handler then commits one minimal, idempotent, workspace-bound
command receipt and acknowledges. Internal principal resolution, domain writes,
and Slack calls happen in the worker. The receipt transaction is the sole
pre-ack database exception. The release target is p95 below 500 ms, p99 below
one second, and no interaction above Slack's three-second acknowledgement
deadline.

Measure the deployed signed-ingress rejection path without creating domain
state:

```powershell
$env:KNOT_PUBLIC_SLACK_URL='https://YOUR-PUBLIC-HOST/slack/events'
$env:KNOT_ACK_CONCURRENCY='1'
npm run measure:ack
```

The probe first verifies that unsigned, forged-signature, and correctly signed
stale-replay requests each receive HTTP 401. Its JSON output records those
checks beside the acknowledgement percentiles.

Record the JSON output in the Phase-1 evidence. This synthetic probe deliberately
uses a different workspace identity and therefore cannot prove the durable
receipt path; the state-changing Slack interactions above must also complete
without Slack timeout banners.

## Capability boundary

This skeleton has no Slackbot MCP dependency, Slack-hosted MCP server, RTS,
Agent View, App Home, or Linear path. Those are deliberately absent until this
complete live Slack gate passes.

Until every positive and negative path above has current recorded sandbox
evidence, Knot remains an in-development Phase-1 app and must not be described
as publishable.
