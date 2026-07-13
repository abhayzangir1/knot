import { describe, expect, it } from "vitest";

import {
  assertAudienceRespectsPrivacyScope,
  assertCompleteOutcomeContract,
  hasAudiencePermission,
  type OutcomeContractDraft,
  OutcomeContractSchema,
  OutcomeDomainError,
} from "../../src/outcomes/index.js";
import { makeOutcome } from "../helpers/outcome.js";

describe("Outcome Contract", () => {
  it("accepts the complete eight-field contract", () => {
    expect(OutcomeContractSchema.safeParse(makeOutcome().contract).success).toBe(true);
  });

  it("rejects two accountable owners", () => {
    const outcome = makeOutcome();
    const contract: OutcomeContractDraft = {
      ...outcome.contract,
      participants: [
        { principalId: "owner-1", roles: ["owner"] },
        { principalId: "owner-2", roles: ["owner"] },
      ],
    };

    expect(() => assertCompleteOutcomeContract(contract)).toThrow(OutcomeDomainError);
  });

  it("does not grant participant access without an audience grant", () => {
    const outcome = makeOutcome();
    const participantOnly = "contributor-1";

    expect(
      hasAudiencePermission({
        audience: outcome.audience,
        actorPrincipalId: participantOnly,
        permission: "view",
      }),
    ).toBe(false);
  });

  it("rejects an audience which broadens a selected-people outcome", () => {
    const outcome = makeOutcome({
      audience: {
        grants: [
          {
            id: "workspace-grant",
            subject: { kind: "workspace", workspaceId: "workspace-1" },
            permissions: ["view"],
          },
        ],
      },
    });

    expect(() => assertAudienceRespectsPrivacyScope(outcome)).toThrow("selected-people");
  });
});
