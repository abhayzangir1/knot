# Knot future demo script (unrecorded)

> **Historical status:** No qualifying final video using this script was
> completed before the challenge deadline. This is a future recording template,
> not proof of current behavior. The MCP sequence and any unpassed live Slack
> sequence must be removed or implemented and verified before this script is
> used. See [CONTINUATION_GUIDE.md](CONTINUATION_GUIDE.md) for current status.

Target length: **2:50**. Hard maximum: **2:59**. Record in English at 1080p,
30 fps. Use narration only; do not add copyrighted music.

This script becomes usable only after the live Slack and MCP gates in
`DEVPOST_SUBMISSION.md` pass. Every screen shown must be the deployed build, not
a mock, prototype, or edited replacement.

## Recording setup

1. Wake `https://knot-1pc1.onrender.com/readyz` and confirm HTTP 200.
2. Open Slack web in separate browser profiles for:
   - creator and next-move actor: `abhayzangir`
   - accountable owner: `Lucky Zangir`
   - independent reviewer: `66blanky`
3. Open Slackbot in the profile authorized to use Knot Core MCP.
4. Open `docs/architecture.png` full screen in a final browser tab.
5. Set Slack zoom so the whole Knot card fits. Close notification banners,
   personal DMs, bookmarks, developer consoles, logs, and all secret-bearing
   pages.
6. Turn off desktop notifications and pause status. Use clean cuts between
   profiles; never show passwords, invite links, tokens, or private evidence.
7. Prepare one fresh outcome immediately before recording so no plan expires.

## Exact demo data

Post this source message in the demo channel:

> Please publish the final Knot demo and submit it to the Slack Agent Builder
> Challenge before the deadline. Share the Devpost confirmation receipt.

Use these confirmed fields in **Tie it up**:

| Field | Value |
| --- | --- |
| Outcome type | Request |
| Goal | Submit Knot to the Slack Agent Builder Challenge before the deadline and share the Devpost confirmation receipt. |
| Accountable owner | Lucky Zangir |
| Independent reviewer | 66blanky |
| Definition of done | Devpost confirms that Knot was submitted to the Slack Agent Builder Challenge, and the submission confirmation receipt or link is recorded as evidence. |
| Next move | Prepare the final Devpost submission, submit it, and record the confirmation receipt as completion evidence. |
| Next-move actor | abhayzangir |
| Review point | Specific date and time before the submission deadline |
| Evidence | Open and confirm the selected Slack source message |
| Participants | Confirm the creator, owner, next-move actor, and reviewer roles |
| Privacy scope | Selected people |

For the immutable update preview, use:

> Submission package prepared; awaiting independent approval before the final
> update is recorded.

For closure evidence, use the real public Devpost project or confirmation URL.
Never use a placeholder URL in the recording.

## Shot-by-shot script

### 0:00–0:12 — The problem and hook

**On screen:** The source Slack message. Hover over **More actions**, then reveal
**Tie it up with Knot**.

**Narration:**

> Important work starts in Slack, but ownership, the next move, and proof of
> completion are usually left implicit. Knot turns one loose end into a verified
> outcome without turning Slack into another task list.

### 0:12–0:34 — Confirm the Outcome Contract

**On screen:** Open **Tie it up with Knot**. Scroll quickly through the populated
demo fields. Pause on owner, reviewer, next-move actor, source evidence, and
**Selected people**. Submit.

**Narration:**

> The creator confirms every field: goal, exactly one owner, definition of done,
> next move and actor, review point, evidence, participants, and privacy. The
> model never silently assigns, shares, approves, or closes anything.

**Edit note:** Use a speed ramp or clean jump cut for typing, but show the final
values before clicking **Create outcome**.

### 0:34–0:50 — Separate ownership acceptance

**On screen:** Cut to Lucky Zangir’s Knot Messages. Show the complete private
ownership request and click **Accept ownership**. Pause on the Active owner card.

**Narration:**

> Creation is still private and inactive until the proposed owner separately
> accepts accountability. After acceptance, each person receives a private card
> with only the controls their role permits.

### 0:50–1:04 — Role-specific controls

**On screen:** Three quick cuts:

1. Owner card: **Check status**, **Submit closure evidence**, correction, and
   delegation.
2. Next-move actor: **Prepare progress update**.
3. Reviewer before a plan exists: **Check status** only.

**Narration:**

> Visibility is not authority. The owner, next-move actor, reviewer, and executor
> see different actions. Replaying a button value cannot grant a permission.

### 1:04–1:24 — Immutable plan

**On screen:** As abhayzangir, click **Prepare progress update**, enter the exact
demo update, and submit. Show the durable accepted receipt, then cut to the
reviewer’s **Review exact update** request with target, plan hash, and expiry.

**Narration:**

> The next-move actor proposes an update. Knot freezes the exact before and after
> state, target, policy version, evidence snapshot, plan hash, and expiry.
> Nothing has been approved or run.

### 1:24–1:42 — Independent approval

**On screen:** As 66blanky, open **Review exact update**. Show the before/after
preview and click the approval control. Cut to the executor’s approved card.

**Narration:**

> A shared outcome requires an independent reviewer. The requester, owner, and
> executor cannot approve their own consequential action. Approval is bound to
> this exact, unexpired plan.

### 1:42–2:02 — Real action, receipt, and rollback

**On screen:** As the named executor, click **Execute approved update**. Show the
app-owned card changing and the Slack receipt. Then click **Restore previous
card** and show the original card restored.

**Narration:**

> The named executor performs one real Slack `chat.update`. Knot records Slack’s
> receipt and the exact before and after payloads. Rollback restores the previous
> card only if the current version still matches, so newer work is never
> overwritten.

### 2:02–2:22 — Real MCP status query

**On screen:** Open Slackbot and paste:

> Use Knot to check the current status of my visible outcome about submitting
> Knot. Return its accountable owner, deterministic next move, and evidence
> status. Do not create, approve, execute, or close anything.

Show Slack’s tool confirmation, approve the read-only call, and show Slackbot’s
result.

**Narration:**

> Slackbot calls Knot Core through MCP using my Slack identity. MCP is a secured
> adapter over the same deterministic services; it cannot bypass the outcome’s
> tenant, audience, lifecycle, or authorization rules.

**Recording gate:** If the tool confirmation and real result are not visible,
stop recording. Do not replace this shot with the MCP settings page.

### 2:22–2:40 — Evidence-based closure

**On screen:** As Lucky Zangir, click **Submit closure evidence**. Enter the real
public Devpost receipt URL, confirm, and show the detailed Closed card. Briefly
show that only the owner has **Reopen outcome**.

**Narration:**

> Action success does not equal completion. Only the accountable owner submits
> closure evidence. Knot validates authority, freshness, type, metadata, and
> evidence access, then records an auditable closure without pretending it read
> the external page.

### 2:40–2:50 — Architecture and close

**On screen:** Full-screen `docs/architecture.png`. Slowly zoom from Slack and
MCP adapters to deterministic services, policies, PostgreSQL, and the durable
worker. End on the Knot name and tagline.

**Narration:**

> Slack and MCP are thin transports. Deterministic services remain the single
> source of truth. Knot ties up every loose end—without surrendering control.

## Capture checklist

- [ ] Final cut is 2:50 or shorter.
- [ ] Every click is from the stable deployed app.
- [ ] The exact-plan approval, Slack receipt, rollback, closure card, and MCP
  tool confirmation are legible.
- [ ] No duplicate status receipts, timeout banners, error toasts, expired plan,
  or dead controls appear.
- [ ] No secret, email inbox, private invite link, Render log, or browser password
  appears.
- [ ] No copyrighted music or unauthorized third-party visual is present.
- [ ] Upload is public and plays at 1080p while signed out.

## If one take fails

Do not hide a broken state with narration. Restart with a fresh outcome when a
plan expires. If execution is `unknown`, if rollback is stale, or if MCP does
not return a real tool result, stop and diagnose before recording again.
