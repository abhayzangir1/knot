import { createHash, randomUUID } from "node:crypto";

import { type Outcome, OutcomeDomainError } from "./types.js";

export const ExecutionState = [
  "planned",
  "approved",
  "dispatching",
  "applied",
  "failed",
  "unknown",
  "compensating",
  "compensated",
  "manual_resolution",
] as const;
export type ExecutionState = (typeof ExecutionState)[number];

export const Reversibility = ["reversible", "compensatable", "irreversible"] as const;
export type Reversibility = (typeof Reversibility)[number];

export type ActionPlan = {
  id: string;
  /** Monotonic compare-and-swap revision; it is not part of the immutable plan hash. */
  version: number;
  workspaceId: string;
  outcomeId: string;
  outcomeVersion: number;
  contractVersion: number;
  createdByPrincipalId: string;
  executorPrincipalId: string;
  policyVersion: string;
  evidenceSnapshotIds: readonly string[];
  beforeState: Record<string, unknown>;
  proposedActions: readonly Record<string, unknown>[];
  reversibility: Reversibility;
  planHash: string;
  idempotencyKey: string;
  expiresAt: string;
  state: ExecutionState;
  approval?: ActionApproval;
  executionReceipt?: ExecutionReceipt;
  compensationReceipt?: ExecutionReceipt;
};

export type ExecutionReceipt = {
  actionPlanId: string;
  externalVersion?: string;
  receipt: Record<string, unknown>;
};

export type ActionApproval = {
  approverPrincipalId: string;
  approvedAt: string;
  policyVersion: string;
  planHash: string;
};

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashExternalState(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function calculatePlanHash(
  plan: Omit<ActionPlan, "id" | "version" | "planHash" | "state" | "approval" | "executionReceipt">,
): string {
  return createHash("sha256").update(stableJson(plan)).digest("hex");
}

export function createActionPlan(
  input: Omit<
    ActionPlan,
    "id" | "version" | "planHash" | "state" | "approval" | "executionReceipt"
  > & { id?: string },
): ActionPlan {
  const { id = randomUUID(), ...planInput } = input;
  return {
    ...planInput,
    id,
    version: 1,
    planHash: calculatePlanHash(planInput),
    state: "planned",
  };
}

export function assertExecutablePlan(
  plan: ActionPlan,
  outcome: Outcome,
  now: string,
  approvalPlanHash: string,
): void {
  if (plan.state !== "approved") {
    throw new OutcomeDomainError("action_not_approved", "The action plan is not approved.");
  }
  if (plan.workspaceId !== outcome.workspaceId || plan.outcomeId !== outcome.id) {
    throw new OutcomeDomainError(
      "action_plan_outcome_mismatch",
      "The plan does not belong to this outcome.",
    );
  }
  if (plan.outcomeVersion !== outcome.version || plan.contractVersion !== outcome.contractVersion) {
    throw new OutcomeDomainError(
      "action_plan_stale",
      "The outcome changed after the action preview.",
    );
  }
  if (now >= plan.expiresAt) {
    throw new OutcomeDomainError("action_plan_expired", "The action preview has expired.");
  }
  if (plan.planHash !== approvalPlanHash) {
    throw new OutcomeDomainError(
      "action_plan_hash_mismatch",
      "The approved plan differs from this plan.",
    );
  }
  if (
    !plan.approval ||
    plan.approval.planHash !== plan.planHash ||
    plan.approval.policyVersion !== plan.policyVersion
  ) {
    throw new OutcomeDomainError(
      "action_approval_binding_missing",
      "The action is missing a valid exact-plan approval binding.",
    );
  }
}

export function assertCompensationCanProceed(
  plan: ActionPlan,
  receipt: ExecutionReceipt,
  currentExternalVersion: string | undefined,
): void {
  if (plan.reversibility === "irreversible") {
    throw new OutcomeDomainError("action_irreversible", "This action has no safe rollback.");
  }
  if (plan.state !== "applied") {
    throw new OutcomeDomainError(
      "action_not_applied",
      "Only an applied action may be compensated.",
    );
  }
  if (receipt.actionPlanId !== plan.id) {
    throw new OutcomeDomainError(
      "receipt_plan_mismatch",
      "The execution receipt belongs to another plan.",
    );
  }
  if (!receipt.externalVersion || !currentExternalVersion) {
    throw new OutcomeDomainError(
      "compensation_version_unknown",
      "Knot cannot verify the current external version, so it will not overwrite the record.",
    );
  }
  if (receipt.externalVersion !== currentExternalVersion) {
    throw new OutcomeDomainError(
      "compensation_stale",
      "The external record changed after execution; compensation requires manual resolution.",
    );
  }
}
