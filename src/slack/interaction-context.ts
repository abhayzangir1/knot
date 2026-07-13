import { randomUUID } from "node:crypto";

import type { ActorContext } from "../outcomes/index.js";

/**
 * A careful Outcome Contract review can take longer than a short interaction.
 * The reference remains actor-bound, single-use, and contains no source text in
 * the durable store, so one hour preserves review usability without granting
 * authority or creating an indefinitely reusable capability.
 */
export const SHORTCUT_CONTEXT_TTL_MILLISECONDS = 60 * 60 * 1000;

export type ShortcutContext = {
  reference: string;
  creator: Pick<ActorContext, "workspaceId" | "principalId">;
  source: {
    channelId: string;
    messageTs: string;
    text: string;
    permalink: string;
    observedAt: string;
  };
  expiresAt: string;
};

export type CreateShortcutContextInput = Omit<ShortcutContext, "reference" | "expiresAt"> & {
  reference?: string;
};

export type InteractionContextScope = Pick<ActorContext, "workspaceId" | "principalId">;

/**
 * Short-lived, single-use modal state. A reference can locate server state but
 * never grants access; the submitting Slack actor is checked separately.
 */
export interface InteractionContextStore {
  create(input: CreateShortcutContextInput, ttlMilliseconds?: number): Promise<ShortcutContext>;
  get(reference: string, scope: InteractionContextScope): Promise<ShortcutContext | undefined>;
  consume(reference: string, scope: InteractionContextScope): Promise<ShortcutContext | undefined>;
  delete(reference: string, workspaceId?: string): Promise<void>;
}

export class InMemoryInteractionContextStore implements InteractionContextStore {
  private readonly records = new Map<string, ShortcutContext>();

  public async create(
    input: CreateShortcutContextInput,
    ttlMilliseconds = SHORTCUT_CONTEXT_TTL_MILLISECONDS,
  ): Promise<ShortcutContext> {
    this.prune();
    const context: ShortcutContext = {
      ...input,
      reference: input.reference ?? randomUUID(),
      expiresAt: new Date(Date.now() + ttlMilliseconds).toISOString(),
    };
    this.records.set(context.reference, structuredClone(context));
    return context;
  }

  public async get(
    reference: string,
    scope: InteractionContextScope,
  ): Promise<ShortcutContext | undefined> {
    this.prune();
    const record = this.records.get(reference);
    if (
      !record ||
      record.creator.workspaceId !== scope.workspaceId ||
      record.creator.principalId !== scope.principalId
    ) {
      return undefined;
    }
    return structuredClone(record);
  }

  public async consume(
    reference: string,
    scope: InteractionContextScope,
  ): Promise<ShortcutContext | undefined> {
    this.prune();
    const record = this.records.get(reference);
    if (
      !record ||
      record.creator.workspaceId !== scope.workspaceId ||
      record.creator.principalId !== scope.principalId
    ) {
      return undefined;
    }
    this.records.delete(reference);
    return structuredClone(record);
  }

  public async delete(reference: string, workspaceId?: string): Promise<void> {
    const record = this.records.get(reference);
    if (!record || (workspaceId && record.creator.workspaceId !== workspaceId)) {
      return;
    }
    this.records.delete(reference);
  }

  private prune(): void {
    const now = Date.now();
    for (const [reference, record] of this.records) {
      if (Date.parse(record.expiresAt) <= now) {
        this.records.delete(reference);
      }
    }
  }
}

export function parseOpaqueReference(privateMetadata: string): string | undefined {
  try {
    const parsed = JSON.parse(privateMetadata) as { ref?: unknown };
    return typeof parsed.ref === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(parsed.ref)
      ? parsed.ref
      : undefined;
  } catch {
    return undefined;
  }
}
