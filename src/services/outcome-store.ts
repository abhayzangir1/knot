import type { ActionPlan, Outcome } from "../outcomes/index.js";

export type SlackCardReference = {
  channelId: string;
  messageTs: string;
  audience: {
    kind: "personal" | "selected_people";
    principalIds: readonly string[];
  };
  blocks: readonly Record<string, unknown>[];
  fallbackText: string;
};

export type StoredAuditEvent = {
  id: string;
  workspaceId: string;
  outcomeId?: string;
  actorPrincipalId?: string;
  type: string;
  correlationId: string;
  causationId: string;
  at: string;
  details: Record<string, unknown>;
  policyVersion?: string;
};

export interface OutcomeStore {
  transaction<T>(work: () => Promise<T>): Promise<T>;
  createOutcome(outcome: Outcome): Promise<void>;
  getOutcome(outcomeId: string, workspaceId?: string): Promise<Outcome | undefined>;
  updateOutcome(outcome: Outcome, expectedVersion: number): Promise<void>;
  deleteOutcome(outcomeId: string, workspaceId: string): Promise<void>;
  saveActionPlan(plan: ActionPlan): Promise<void>;
  getActionPlan(actionPlanId: string, workspaceId?: string): Promise<ActionPlan | undefined>;
  updateActionPlan(plan: ActionPlan, expectedVersion: number): Promise<void>;
  setSlackCardReference(
    outcomeId: string,
    workspaceId: string,
    card: SlackCardReference,
  ): Promise<void>;
  getSlackCardReference(
    outcomeId: string,
    workspaceId?: string,
  ): Promise<SlackCardReference | undefined>;
  appendAudit(event: StoredAuditEvent): Promise<void>;
  listAudit(outcomeId: string, workspaceId?: string): Promise<readonly StoredAuditEvent[]>;
}

export class InMemoryOutcomeStore implements OutcomeStore {
  private readonly outcomes = new Map<string, Outcome>();
  private readonly actionPlans = new Map<string, ActionPlan>();
  private readonly cards = new Map<string, SlackCardReference>();
  private readonly auditEvents: StoredAuditEvent[] = [];
  private transactionTail: Promise<void> = Promise.resolve();

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.transactionTail;
    let release: (() => void) | undefined;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const outcomes = structuredClone(this.outcomes);
    const actionPlans = structuredClone(this.actionPlans);
    const cards = structuredClone(this.cards);
    const auditEvents = structuredClone(this.auditEvents);
    try {
      return await work();
    } catch (error) {
      this.outcomes.clear();
      this.actionPlans.clear();
      this.cards.clear();
      this.auditEvents.length = 0;
      for (const [key, value] of outcomes) this.outcomes.set(key, value);
      for (const [key, value] of actionPlans) this.actionPlans.set(key, value);
      for (const [key, value] of cards) this.cards.set(key, value);
      this.auditEvents.push(...auditEvents);
      throw error;
    } finally {
      release?.();
    }
  }

  async createOutcome(outcome: Outcome): Promise<void> {
    if (this.outcomes.has(outcome.id)) {
      throw new Error(`Outcome ${outcome.id} already exists.`);
    }
    this.outcomes.set(outcome.id, structuredClone(outcome));
  }

  async getOutcome(outcomeId: string, workspaceId?: string): Promise<Outcome | undefined> {
    const outcome = this.outcomes.get(outcomeId);
    if (!outcome || (workspaceId && outcome.workspaceId !== workspaceId)) {
      return undefined;
    }
    return structuredClone(outcome);
  }

  async updateOutcome(outcome: Outcome, expectedVersion: number): Promise<void> {
    const existing = this.outcomes.get(outcome.id);
    if (!existing) {
      throw new Error(`Outcome ${outcome.id} does not exist.`);
    }
    if (existing.version !== expectedVersion) {
      throw new Error(`Outcome ${outcome.id} changed concurrently.`);
    }
    this.outcomes.set(outcome.id, structuredClone(outcome));
  }

  async deleteOutcome(outcomeId: string, workspaceId: string): Promise<void> {
    const existing = this.outcomes.get(outcomeId);
    if (!existing || existing.workspaceId !== workspaceId) {
      throw new Error(`Outcome ${outcomeId} does not exist in the requested workspace.`);
    }
    this.outcomes.delete(outcomeId);
    this.cards.delete(outcomeId);
    for (const [planId, plan] of this.actionPlans) {
      if (plan.outcomeId === outcomeId) {
        this.actionPlans.delete(planId);
      }
    }
  }

  async saveActionPlan(plan: ActionPlan): Promise<void> {
    if (this.actionPlans.has(plan.id)) {
      throw new Error(`Action plan ${plan.id} already exists.`);
    }
    this.actionPlans.set(plan.id, structuredClone(plan));
  }

  async getActionPlan(actionPlanId: string, workspaceId?: string): Promise<ActionPlan | undefined> {
    const plan = this.actionPlans.get(actionPlanId);
    if (!plan || (workspaceId && plan.workspaceId !== workspaceId)) {
      return undefined;
    }
    return structuredClone(plan);
  }

  async updateActionPlan(plan: ActionPlan, expectedVersion: number): Promise<void> {
    const existing = this.actionPlans.get(plan.id);
    if (!existing) {
      throw new Error(`Action plan ${plan.id} does not exist.`);
    }
    if (existing.version !== expectedVersion) {
      throw new Error(`Action plan ${plan.id} changed concurrently.`);
    }
    this.actionPlans.set(plan.id, structuredClone(plan));
  }

  async setSlackCardReference(
    outcomeId: string,
    workspaceId: string,
    card: SlackCardReference,
  ): Promise<void> {
    const outcome = this.outcomes.get(outcomeId);
    if (!outcome || outcome.workspaceId !== workspaceId) {
      throw new Error(`Outcome ${outcomeId} does not exist in the requested workspace.`);
    }
    this.cards.set(outcomeId, structuredClone(card));
  }

  async getSlackCardReference(
    outcomeId: string,
    workspaceId?: string,
  ): Promise<SlackCardReference | undefined> {
    const outcome = this.outcomes.get(outcomeId);
    if (!outcome || (workspaceId && outcome.workspaceId !== workspaceId)) {
      return undefined;
    }
    const card = this.cards.get(outcomeId);
    return card ? structuredClone(card) : undefined;
  }

  async appendAudit(event: StoredAuditEvent): Promise<void> {
    this.auditEvents.push(structuredClone(event));
  }

  async listAudit(outcomeId: string, workspaceId?: string): Promise<readonly StoredAuditEvent[]> {
    return this.auditEvents
      .filter(
        (event) =>
          event.outcomeId === outcomeId && (!workspaceId || event.workspaceId === workspaceId),
      )
      .map((event) => structuredClone(event));
  }
}
