import { describe, expect, it } from "vitest";

import {
  assertCompensationCanProceed,
  assertExecutablePlan,
  createActionPlan,
  OutcomeDomainError,
} from "../../src/outcomes/index.js";
import { makeOutcome } from "../helpers/outcome.js";

describe("safe execution", () => {
  it("rejects an expired action plan", () => {
    const outcome = makeOutcome({ state: "active" });
    const plan = createActionPlan({
      workspaceId: outcome.workspaceId,
      outcomeId: outcome.id,
      outcomeVersion: outcome.version,
      contractVersion: outcome.contractVersion,
      createdByPrincipalId: "creator-1",
      executorPrincipalId: "owner-1",
      policyVersion: "authority-policy-v1",
      evidenceSnapshotIds: ["evidence-1"],
      beforeState: {},
      proposedActions: [{ kind: "slack.card.update" }],
      reversibility: "reversible",
      idempotencyKey: "action-1",
      expiresAt: "2026-07-11T12:00:00.000Z",
    });
    const approved = { ...plan, state: "approved" as const };

    expect(() =>
      assertExecutablePlan(approved, outcome, "2026-07-12T12:00:00.000Z", approved.planHash),
    ).toThrow("expired");
  });

  it("stops stale external compensation", () => {
    const outcome = makeOutcome({ state: "active" });
    const plan = {
      ...createActionPlan({
        workspaceId: outcome.workspaceId,
        outcomeId: outcome.id,
        outcomeVersion: outcome.version,
        contractVersion: outcome.contractVersion,
        createdByPrincipalId: "creator-1",
        executorPrincipalId: "owner-1",
        policyVersion: "authority-policy-v1",
        evidenceSnapshotIds: ["evidence-1"],
        beforeState: {},
        proposedActions: [{ kind: "linear.issue.update" }],
        reversibility: "compensatable" as const,
        idempotencyKey: "action-2",
        expiresAt: "2026-07-13T12:00:00.000Z",
      }),
      state: "applied" as const,
    };

    expect(() =>
      assertCompensationCanProceed(
        plan,
        { actionPlanId: plan.id, externalVersion: "v1", receipt: {} },
        "v2",
      ),
    ).toThrow(OutcomeDomainError);
  });
});
