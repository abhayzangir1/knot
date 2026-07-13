# Knot submission checklist

**Track:** New Slack Agent  
**Deadline:** 2026-07-13 5:00 p.m. PDT / 2026-07-14 5:30 a.m. IST  
**Rule:** No item is marked complete without current evidence. Local automation
does not substitute for live Slack, stable-host, reviewer-access, video, or
Devpost acceptance evidence.

## Release evidence

- [x] Public source repository exists and push protection accepts the history.
- [x] Format, lint, typecheck, build, and default test suite pass.
- [x] All PostgreSQL-gated tests pass against a fresh isolated database.
- [x] Production and complete dependency audits report zero vulnerabilities.
- [x] Final non-root container passes readiness and has zero Docker Scout
  critical, high, medium, or low findings.
- [x] Signed public-ingress probe rejects unsigned, forged, and stale requests
  and meets the acknowledgement budget through the temporary test tunnel.
- [x] Judge-ready architecture diagram exists as
  [SVG](architecture.svg) and [PNG](architecture.png).
- [ ] Render Blueprint creates one Free web service and one Free PostgreSQL
  database, with no paid instance selected.
- [ ] Render billing shows no unintended paid resource; set the workspace spend
  limit to zero where the account supports it.
- [ ] Wake `/readyz` to HTTP 200 immediately before Slack judging or recording;
  do not count a Free-tier cold start as acknowledgement-latency evidence.
- [ ] Stable `/healthz`, `/readyz`, and `/slack/events` URLs are verified.
- [ ] Stable-host acknowledgement/security probe passes and is recorded in
  [PLANS.md](../PLANS.md).
- [ ] Slack dashboard matches the reviewed manifest and points to the stable
  receiver.
- [ ] Shared-outcome positive path passes from shortcut through receipt,
  rollback, owner-attested closure, and reopen.
- [ ] Shared-outcome role denial, self-approval denial, replay, stale rollback,
  correction, delegation, decline/reassignment, and deletion paths pass.
- [ ] Private single-message outcome path passes with explicit personal
  self-confirmation and no reviewer.
- [ ] Phase 1 is marked complete only after the live evidence is recorded.
- [ ] Knot Core MCP passes protocol, signature, identity, authorization,
  tenant-isolation, schema, output, and audit tests.
- [ ] Slackbot discovers and invokes a real Knot tool through Slack identity
  auth in the target sandbox; Slack's tool confirmation is visible.
- [ ] Final container, stable deployment, Slack manifest, and probes are rerun
  after the MCP change.

## Judge access and submission

- [ ] Invite `slackhack@salesforce.com` to the Slack developer sandbox.
- [ ] Invite `testing@devpost.com` to the Slack developer sandbox.
- [ ] Confirm both invitations or memberships from the sandbox admin view.
- [ ] Record the exact developer-sandbox URL without including credentials.
- [ ] Record a comprehensive English demo under three minutes that shows the
  functioning project and the real MCP integration.
- [ ] Exclude secrets, private evidence, copyrighted music, and unauthorized
  third-party trademarks from the recording.
- [ ] Upload the video publicly to YouTube, Vimeo, Facebook Video, or Youku and
  verify it while signed out.
- [ ] Use [architecture.png](architecture.png) as the submitted architecture
  diagram and visually inspect the uploaded copy.
- [ ] Complete the New Slack Agent text description without claiming
  unavailable, untested, or future behavior.
- [ ] Submit before the deadline and capture the accepted Devpost receipt.

## Final security cutover

- [ ] Rotate any Slack credential exposed outside the approved secret stores.
- [ ] Update the stable host with the rotated values and redeploy.
- [ ] Reinstall or reauthorize the app when Slack requires it.
- [ ] Rerun authentication, readiness, signed ingress, one positive action, and
  one denial after rotation.
- [ ] Confirm `.env` and deployment secrets remain untracked and GitHub push
  protection remains clean.

Primary rule source: [Slack Agent Builder Challenge official
rules](https://slackhack.devpost.com/rules).
