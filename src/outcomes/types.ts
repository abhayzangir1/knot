import { z } from "zod";

/**
 * The domain core intentionally uses stable, application-owned identifiers.
 * Slack IDs, connector IDs, and transport payloads are mapped at the edge.
 */
export const IdentifierSchema = z.string().trim().min(1).max(256);
export const IsoTimestampSchema = z.string().datetime({ offset: true });
export const PrincipalIdSchema = IdentifierSchema;
export const WorkspaceIdSchema = IdentifierSchema;
export const OutcomeIdSchema = IdentifierSchema;

export class OutcomeDomainError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OutcomeDomainError";
  }
}

export const OutcomeTypeSchema = z.enum(["request", "decision", "commitment", "handoff", "other"]);
export type OutcomeType = z.infer<typeof OutcomeTypeSchema>;

export const OutcomeStateSchema = z.enum([
  "proposed",
  "clarified",
  "awaiting_owner_acceptance",
  "active",
  "waiting",
  "at_risk",
  "blocked",
  "closure_requested",
  "closed",
  "cancelled",
]);
export type OutcomeState = z.infer<typeof OutcomeStateSchema>;

export const EvidenceFreshnessSchema = z.enum(["fresh", "stale", "unknown", "conflicting"]);
export type EvidenceFreshness = z.infer<typeof EvidenceFreshnessSchema>;

export const EvidenceKindSchema = z.enum([
  "slack_message",
  "slack_thread",
  "manual_note",
  "linear_issue",
  "decision_record",
  "completion_record",
  "handoff_confirmation",
  "system_record",
]);

export const EvidenceReferenceSchema = z
  .object({
    id: IdentifierSchema,
    kind: EvidenceKindSchema,
    label: z.string().trim().min(1).max(500),
    locator: z.string().trim().min(1).max(2_000),
    observedAt: IsoTimestampSchema,
    freshness: EvidenceFreshnessSchema,
    verification: z
      .object({
        method: z.enum(["authorized_user_attestation", "provider_receipt", "system_check"]),
        verifiedAt: IsoTimestampSchema,
        verifiedByPrincipalId: PrincipalIdSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;

export const ParticipantRoleSchema = z.enum([
  "owner",
  "contributor",
  "delegate",
  "requester",
  "beneficiary",
  "decider",
  "handoff_sender",
  "handoff_recipient",
  "observer",
]);
export type ParticipantRole = z.infer<typeof ParticipantRoleSchema>;

const uniqueStrings = (values: readonly string[]): boolean =>
  new Set(values).size === values.length;

export const ParticipantSchema = z
  .object({
    principalId: PrincipalIdSchema,
    roles: z.array(ParticipantRoleSchema).min(1).refine(uniqueStrings, {
      message: "Participant roles must not contain duplicates.",
    }),
  })
  .strict();
export type Participant = z.infer<typeof ParticipantSchema>;

export const NextMoveSchema = z
  .object({
    description: z.string().trim().min(1).max(1_000),
    actorPrincipalId: PrincipalIdSchema,
    dueAt: IsoTimestampSchema.optional(),
  })
  .strict();
export type NextMove = z.infer<typeof NextMoveSchema>;

export const ReviewPointSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("at"),
      at: IsoTimestampSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("on_event"),
      event: z.string().trim().min(1).max(1_000),
    })
    .strict(),
]);
export type ReviewPoint = z.infer<typeof ReviewPointSchema>;

/**
 * Privacy scope declares the intended visibility boundary. It does not grant
 * access; AuthorizedAudience grants are the source of authorization.
 * Connected systems are deliberately modeled separately below.
 */
export const PrivacyScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("private") }).strict(),
  z.object({ kind: z.literal("selected_people") }).strict(),
  z
    .object({
      kind: z.literal("channel"),
      channelId: IdentifierSchema,
    })
    .strict(),
  z.object({ kind: z.literal("workspace") }).strict(),
]);
export type PrivacyScope = z.infer<typeof PrivacyScopeSchema>;

const OutcomeContractFieldsSchema = z
  .object({
    goal: z.string().trim().min(1).max(2_000),
    accountableOwnerPrincipalId: PrincipalIdSchema,
    definitionOfDone: z.string().trim().min(1).max(2_000),
    nextMove: NextMoveSchema,
    reviewPoint: ReviewPointSchema,
    evidence: z.array(EvidenceReferenceSchema).min(1),
    participants: z.array(ParticipantSchema).min(1),
    privacyScope: PrivacyScopeSchema,
  })
  .strict();

export const OutcomeContractDraftSchema = OutcomeContractFieldsSchema.partial();
export type OutcomeContractDraft = z.infer<typeof OutcomeContractDraftSchema>;

/**
 * An Outcome Contract is the minimal anti-task-manager invariant. A shared
 * active outcome must carry every field and exactly one accountable owner.
 */
export const OutcomeContractSchema = OutcomeContractFieldsSchema.superRefine(
  (contract, context) => {
    const ownerParticipants = contract.participants.filter((participant) =>
      participant.roles.includes("owner"),
    );

    if (ownerParticipants.length !== 1) {
      context.addIssue({
        code: "custom",
        path: ["participants"],
        message: "The contract must contain exactly one owner participant.",
      });
      return;
    }

    const ownerParticipant = ownerParticipants[0];
    if (
      ownerParticipant === undefined ||
      ownerParticipant.principalId !== contract.accountableOwnerPrincipalId
    ) {
      context.addIssue({
        code: "custom",
        path: ["accountableOwnerPrincipalId"],
        message: "The accountable owner must be the sole participant with the owner role.",
      });
    }

    const participantIds = contract.participants.map((participant) => participant.principalId);
    if (!uniqueStrings(participantIds)) {
      context.addIssue({
        code: "custom",
        path: ["participants"],
        message: "A participant may only appear once in an Outcome Contract.",
      });
    }

    const evidenceIds = contract.evidence.map((evidence) => evidence.id);
    if (!uniqueStrings(evidenceIds)) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "Evidence references must have unique IDs.",
      });
    }
  },
);
export type OutcomeContract = z.infer<typeof OutcomeContractSchema>;

export const OutcomeContractFieldSchema = z.enum([
  "goal",
  "accountableOwnerPrincipalId",
  "definitionOfDone",
  "nextMove",
  "reviewPoint",
  "evidence",
  "participants",
  "privacyScope",
]);
export type OutcomeContractField = z.infer<typeof OutcomeContractFieldSchema>;

export const OUTCOME_CONTRACT_FIELDS = [
  "goal",
  "accountableOwnerPrincipalId",
  "definitionOfDone",
  "nextMove",
  "reviewPoint",
  "evidence",
  "participants",
  "privacyScope",
] as const satisfies readonly OutcomeContractField[];

export const ContractFieldSourceSchema = z.enum(["user", "model", "system"]);
export type ContractFieldSource = z.infer<typeof ContractFieldSourceSchema>;

/**
 * Provenance is required per field before shared activation. It lets the
 * application distinguish user supplied data from model suggestions.
 */
export const ContractFieldProvenanceSchema = z
  .object({
    field: OutcomeContractFieldSchema,
    source: ContractFieldSourceSchema,
    evidenceIds: z.array(IdentifierSchema),
    freshness: EvidenceFreshnessSchema,
    confidence: z.number().min(0).max(1).optional(),
    confirmedByPrincipalId: PrincipalIdSchema.optional(),
    confirmedAt: IsoTimestampSchema.optional(),
  })
  .strict()
  .superRefine((provenance, context) => {
    if (provenance.source === "model" && provenance.confidence === undefined) {
      context.addIssue({
        code: "custom",
        path: ["confidence"],
        message: "Model-extracted fields must have a confidence value.",
      });
    }

    if (
      (provenance.confirmedByPrincipalId === undefined) !==
      (provenance.confirmedAt === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "A confirmation principal and confirmation timestamp must be recorded together.",
      });
    }
  });
export type ContractFieldProvenance = z.infer<typeof ContractFieldProvenanceSchema>;

export const ModelCandidateOutcomeContractSchema = z
  .object({
    contract: OutcomeContractDraftSchema,
    provenance: z.array(ContractFieldProvenanceSchema),
    modelId: z.string().trim().min(1).max(256),
    generatedAt: IsoTimestampSchema,
  })
  .strict();
export type ModelCandidateOutcomeContract = z.infer<typeof ModelCandidateOutcomeContractSchema>;

export const AudiencePermissionSchema = z.enum([
  "view",
  "edit",
  "approve",
  "execute",
  "evidence_access",
]);
export type AudiencePermission = z.infer<typeof AudiencePermissionSchema>;

export const AudienceSubjectSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("principal"),
      principalId: PrincipalIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("channel"),
      channelId: IdentifierSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("workspace"),
      workspaceId: WorkspaceIdSchema,
    })
    .strict(),
]);
export type AudienceSubject = z.infer<typeof AudienceSubjectSchema>;

export function audienceSubjectKey(subject: AudienceSubject): string {
  switch (subject.kind) {
    case "principal":
      return `principal:${subject.principalId}`;
    case "channel":
      return `channel:${subject.channelId}`;
    case "workspace":
      return `workspace:${subject.workspaceId}`;
  }
}

export const AudienceGrantSchema = z
  .object({
    id: IdentifierSchema,
    subject: AudienceSubjectSchema,
    permissions: z.array(AudiencePermissionSchema).min(1).refine(uniqueStrings, {
      message: "Audience grant permissions must not contain duplicates.",
    }),
  })
  .strict();
export type AudienceGrant = z.infer<typeof AudienceGrantSchema>;

/**
 * Participants never imply audience membership. The only way to read or act
 * on an outcome is an explicit audience grant (or a separately resolved group
 * grant supplied by the edge adapter).
 */
export const AuthorizedAudienceSchema = z
  .object({
    grants: z.array(AudienceGrantSchema).min(1),
  })
  .strict()
  .superRefine((audience, context) => {
    const subjectKeys = audience.grants.map((grant) => audienceSubjectKey(grant.subject));
    if (!uniqueStrings(subjectKeys)) {
      context.addIssue({
        code: "custom",
        path: ["grants"],
        message: "An authorized audience may only grant a subject once.",
      });
    }
  });
export type AuthorizedAudience = z.infer<typeof AuthorizedAudienceSchema>;

export interface AudienceAccessInput {
  audience: AuthorizedAudience;
  actorPrincipalId: string;
  permission: AudiencePermission;
  /**
   * Channel/workspace membership is resolved by a verified edge adapter. The
   * core never guesses membership from a participant record.
   */
  resolvedSubjects?: readonly AudienceSubject[];
}

export function hasAudiencePermission(input: AudienceAccessInput): boolean {
  const resolvedSubjectKeys = new Set(
    input.resolvedSubjects?.map((subject) => audienceSubjectKey(subject)) ?? [],
  );
  resolvedSubjectKeys.add(`principal:${input.actorPrincipalId}`);

  return input.audience.grants.some(
    (grant) =>
      grant.permissions.includes(input.permission) &&
      resolvedSubjectKeys.has(audienceSubjectKey(grant.subject)),
  );
}

export interface AudienceScopeValidationInput {
  privacyScope: PrivacyScope;
  audience: AuthorizedAudience;
  workspaceId: string;
  privateAllowedPrincipalIds: readonly string[];
}

export type AudienceScopeValidationResult = { valid: true } | { valid: false; reason: string };

/**
 * Ensures that the declarative privacy scope and explicit ACL cannot disagree
 * in a way that accidentally broadens access.
 */
export function validateAudienceForPrivacyScope(
  input: AudienceScopeValidationInput,
): AudienceScopeValidationResult {
  const grants = input.audience.grants;

  if (input.privacyScope.kind === "private") {
    const allowed = new Set(input.privateAllowedPrincipalIds);
    const hasLeak = grants.some(
      (grant) => grant.subject.kind !== "principal" || !allowed.has(grant.subject.principalId),
    );
    return hasLeak
      ? {
          valid: false,
          reason: "A private outcome may only grant explicitly allowed principals.",
        }
      : { valid: true };
  }

  if (input.privacyScope.kind === "selected_people") {
    const hasNonPrincipalGrant = grants.some((grant) => grant.subject.kind !== "principal");
    return hasNonPrincipalGrant
      ? {
          valid: false,
          reason: "A selected-people outcome may only contain principal audience grants.",
        }
      : { valid: true };
  }

  if (input.privacyScope.kind === "channel") {
    const channelId = input.privacyScope.channelId;
    const hasWorkspaceGrant = grants.some((grant) => grant.subject.kind === "workspace");
    const hasExpectedChannelViewer = grants.some(
      (grant) =>
        grant.subject.kind === "channel" &&
        grant.subject.channelId === channelId &&
        grant.permissions.includes("view"),
    );
    const hasOtherChannel = grants.some(
      (grant) => grant.subject.kind === "channel" && grant.subject.channelId !== channelId,
    );
    if (hasWorkspaceGrant || hasOtherChannel || !hasExpectedChannelViewer) {
      return {
        valid: false,
        reason:
          "A channel-scoped outcome must grant view access to exactly its scoped channel and never to a workspace.",
      };
    }
    return { valid: true };
  }

  const hasExpectedWorkspaceViewer = grants.some(
    (grant) =>
      grant.subject.kind === "workspace" &&
      grant.subject.workspaceId === input.workspaceId &&
      grant.permissions.includes("view"),
  );
  const hasOtherWorkspace = grants.some(
    (grant) =>
      grant.subject.kind === "workspace" && grant.subject.workspaceId !== input.workspaceId,
  );
  if (!hasExpectedWorkspaceViewer || hasOtherWorkspace) {
    return {
      valid: false,
      reason: "A workspace-scoped outcome must grant view access to its own workspace only.",
    };
  }
  return { valid: true };
}

export const ConnectedSystemProviderSchema = z.enum(["slack", "linear"]);
export type ConnectedSystemProvider = z.infer<typeof ConnectedSystemProviderSchema>;

export const ConnectedSystemCapabilitySchema = z.enum(["read", "write", "compensate"]);
export type ConnectedSystemCapability = z.infer<typeof ConnectedSystemCapabilitySchema>;

/**
 * Links to external systems remain independent from both privacy scope and ACL
 * so a connector reference can never silently broaden who may see an outcome.
 */
export const ConnectedSystemLinkSchema = z
  .object({
    id: IdentifierSchema,
    provider: ConnectedSystemProviderSchema,
    connectionId: IdentifierSchema,
    externalObjectType: z.string().trim().min(1).max(256),
    externalObjectId: IdentifierSchema,
    externalVersion: z.string().trim().min(1).max(1_000).optional(),
    capabilities: z.array(ConnectedSystemCapabilitySchema).min(1).refine(uniqueStrings, {
      message: "Connected-system capabilities must not contain duplicates.",
    }),
    health: z.enum(["healthy", "degraded", "disabled"]),
  })
  .strict();
export type ConnectedSystemLink = z.infer<typeof ConnectedSystemLinkSchema>;

export const DelegationPermissionSchema = z.enum(["edit", "execute", "close", "act_as_owner"]);
export type DelegationPermission = z.infer<typeof DelegationPermissionSchema>;

export const DelegationSchema = z
  .object({
    id: IdentifierSchema,
    delegatorPrincipalId: PrincipalIdSchema,
    delegatePrincipalId: PrincipalIdSchema,
    permissions: z.array(DelegationPermissionSchema).min(1).refine(uniqueStrings, {
      message: "Delegation permissions must not contain duplicates.",
    }),
    status: z.enum(["active", "revoked", "expired"]),
    grantedAt: IsoTimestampSchema,
    expiresAt: IsoTimestampSchema.optional(),
  })
  .strict()
  .refine((delegation) => delegation.delegatorPrincipalId !== delegation.delegatePrincipalId, {
    message: "A principal cannot delegate authority to themselves.",
  });
export type Delegation = z.infer<typeof DelegationSchema>;

export const OwnerAcceptanceSchema = z
  .object({
    requestedOwnerPrincipalId: PrincipalIdSchema,
    status: z.enum(["pending", "accepted", "declined"]),
    respondedByPrincipalId: PrincipalIdSchema.optional(),
    respondedAt: IsoTimestampSchema.optional(),
    declineReason: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict()
  .superRefine((acceptance, context) => {
    const hasResponse = acceptance.respondedByPrincipalId !== undefined;
    const hasRespondedAt = acceptance.respondedAt !== undefined;

    if (hasResponse !== hasRespondedAt) {
      context.addIssue({
        code: "custom",
        message: "Owner acceptance responses must include both a principal and timestamp.",
      });
    }

    if (
      acceptance.status === "accepted" &&
      acceptance.respondedByPrincipalId !== acceptance.requestedOwnerPrincipalId
    ) {
      context.addIssue({
        code: "custom",
        path: ["respondedByPrincipalId"],
        message: "Only the requested owner may accept accountability.",
      });
    }

    if (acceptance.status !== "pending" && !hasResponse) {
      context.addIssue({
        code: "custom",
        message: "An accepted or declined request needs a recorded response.",
      });
    }

    if (acceptance.status === "declined" && acceptance.declineReason === undefined) {
      context.addIssue({
        code: "custom",
        path: ["declineReason"],
        message: "A declined ownership request needs a reason.",
      });
    }
  });
export type OwnerAcceptance = z.infer<typeof OwnerAcceptanceSchema>;

export const OutcomeSchema = z
  .object({
    id: OutcomeIdSchema,
    workspaceId: WorkspaceIdSchema,
    createdByPrincipalId: PrincipalIdSchema,
    type: OutcomeTypeSchema,
    state: OutcomeStateSchema,
    contract: OutcomeContractDraftSchema,
    contractFieldProvenance: z.array(ContractFieldProvenanceSchema),
    ownerAcceptance: OwnerAcceptanceSchema,
    audience: AuthorizedAudienceSchema,
    connectedSystems: z.array(ConnectedSystemLinkSchema),
    delegations: z.array(DelegationSchema),
    version: z.number().int().positive(),
    contractVersion: z.number().int().positive(),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
    closedAt: IsoTimestampSchema.optional(),
    closedByPrincipalId: PrincipalIdSchema.optional(),
    closureEvidenceIds: z.array(IdentifierSchema).min(1).optional(),
  })
  .strict();
export type Outcome = z.infer<typeof OutcomeSchema>;

export function isCompleteOutcomeContract(
  contract: OutcomeContractDraft,
): contract is OutcomeContract {
  return OutcomeContractSchema.safeParse(contract).success;
}

export function assertCompleteOutcomeContract(contract: OutcomeContractDraft): OutcomeContract {
  const result = OutcomeContractSchema.safeParse(contract);
  if (!result.success) {
    throw new OutcomeDomainError(
      "contract_incomplete",
      `Outcome Contract is incomplete or invalid: ${result.error.issues
        .map((issue) => issue.message)
        .join(" ")}`,
    );
  }
  return result.data;
}

export function assertAudienceRespectsPrivacyScope(outcome: Outcome): void {
  const allowedPrivatePrincipals = [outcome.createdByPrincipalId];
  if (outcome.contract.accountableOwnerPrincipalId !== undefined) {
    allowedPrivatePrincipals.push(outcome.contract.accountableOwnerPrincipalId);
  }

  const privacyScope = outcome.contract.privacyScope;
  if (privacyScope === undefined) {
    throw new OutcomeDomainError(
      "privacy_scope_missing",
      "An outcome cannot be shared without a privacy scope.",
    );
  }

  const validation = validateAudienceForPrivacyScope({
    privacyScope,
    audience: outcome.audience,
    workspaceId: outcome.workspaceId,
    privateAllowedPrincipalIds: allowedPrivatePrincipals,
  });
  if (!validation.valid) {
    throw new OutcomeDomainError("audience_scope_mismatch", validation.reason);
  }
}

export function isDelegationActive(delegation: Delegation, at: string): boolean {
  if (delegation.status !== "active") {
    return false;
  }
  return delegation.expiresAt === undefined || delegation.expiresAt > at;
}
