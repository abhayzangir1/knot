import { describe, expect, it } from "vitest";

import {
  type ActorContext,
  assertApprovalSeparationOfDuty,
  assertAuthority,
  defaultAuthorityPolicy,
  OutcomeDomainError,
} from "../../src/outcomes/index.js";
import { makeOutcome, timestamp } from "../helpers/outcome.js";

const actor = (principalId: string): ActorContext => ({
  workspaceId: "workspace-1",
  principalId,
  slackUserId: `slack-${principalId}`,
  correlationId: "correlation-1",
  authenticatedAt: timestamp,
  isWorkspaceAdmin: false,
  resolvedAudienceSubjects: [],
});

const workspaceAdmin = (principalId: string): ActorContext => ({
  ...actor(principalId),
  isWorkspaceAdmin: true,
});

describe("authority policy", () => {
  it("rejects an identity from another tenant", () => {
    const outcome = makeOutcome();
    const foreignActor = { ...actor("creator-1"), workspaceId: "workspace-2" };

    expect(() => assertAuthority(outcome, foreignActor, "view", timestamp)).toThrow("workspace");
  });

  it("allows the requested owner to accept ownership", () => {
    const outcome = makeOutcome({
      ownerAcceptance: { requestedOwnerPrincipalId: "owner-1", status: "pending" },
    });

    expect(() =>
      assertAuthority(outcome, actor("owner-1"), "accept_ownership", timestamp),
    ).not.toThrow();
  });

  it("rejects approval by the action executor", () => {
    expect(() =>
      assertApprovalSeparationOfDuty(
        actor("owner-1"),
        { executorPrincipalId: "owner-1", requesterPrincipalId: "creator-1" },
        defaultAuthorityPolicy,
        false,
      ),
    ).toThrow(OutcomeDomainError);
  });

  it("does not treat workspace administration as outcome authority", () => {
    const outcome = makeOutcome({ state: "active" });
    const administrator = workspaceAdmin("admin-1");

    for (const action of ["approve", "execute", "close", "delegate"] as const) {
      expect(() => assertAuthority(outcome, administrator, action, timestamp)).toThrow(
        "not authorized",
      );
    }
  });

  it("requires the accountable owner role for delegation and closure even with an ACL grant", () => {
    const administrator = workspaceAdmin("admin-1");
    const outcome = makeOutcome({
      state: "active",
      audience: {
        grants: [
          ...makeOutcome().audience.grants,
          {
            id: "audience-admin",
            subject: { kind: "principal", principalId: administrator.principalId },
            permissions: ["view", "edit"],
          },
        ],
      },
    });

    expect(() => assertAuthority(outcome, administrator, "delegate", timestamp)).toThrow(
      "accountable owner",
    );
    expect(() => assertAuthority(outcome, administrator, "close", timestamp)).toThrow(
      "closure authority",
    );
  });

  it("allows only an active delegate with explicit closure authority to act for the owner", () => {
    const base = makeOutcome();
    const delegatedOutcome = makeOutcome({
      state: "active",
      contract: {
        ...base.contract,
        participants: [
          ...(base.contract.participants ?? []),
          { principalId: "delegate-1", roles: ["delegate"] },
        ],
      },
      audience: {
        grants: [
          ...base.audience.grants,
          {
            id: "audience-delegate",
            subject: { kind: "principal", principalId: "delegate-1" },
            permissions: ["view", "edit"],
          },
        ],
      },
      delegations: [
        {
          id: "delegation-1",
          delegatorPrincipalId: "owner-1",
          delegatePrincipalId: "delegate-1",
          permissions: ["close"],
          status: "active",
          grantedAt: timestamp,
        },
      ],
    });

    expect(() =>
      assertAuthority(delegatedOutcome, actor("delegate-1"), "close", timestamp),
    ).not.toThrow();
    expect(() =>
      assertAuthority(
        {
          ...delegatedOutcome,
          delegations: delegatedOutcome.delegations.map((delegation) => ({
            ...delegation,
            permissions: ["execute"],
          })),
        },
        actor("delegate-1"),
        "close",
        timestamp,
      ),
    ).toThrow("closure authority");
  });
});
