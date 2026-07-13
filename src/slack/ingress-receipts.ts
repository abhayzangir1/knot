import { hashExternalState } from "../outcomes/index.js";

export type SlackIngressReceipt = {
  deliveryKey: string;
  workspaceSlackTeamId: string;
  payload: unknown;
};

/** Claims a signed Slack interaction once before any domain command is run. */
export interface SlackIngressReceiptStore {
  claim(receipt: SlackIngressReceipt): Promise<boolean>;
}

export class InMemorySlackIngressReceiptStore implements SlackIngressReceiptStore {
  private readonly deliveryHashes = new Map<string, string>();

  public async claim(receipt: SlackIngressReceipt): Promise<boolean> {
    const key = `${receipt.workspaceSlackTeamId}:${receipt.deliveryKey}`;
    const hash = payloadHash(receipt.payload);
    const existingHash = this.deliveryHashes.get(key);
    if (existingHash !== undefined) {
      if (existingHash !== hash) {
        throw new Error(
          "A Slack delivery key was reused with different payload content; Knot refused the collision.",
        );
      }
      return false;
    }
    this.deliveryHashes.set(key, hash);
    return true;
  }
}

export function payloadHash(payload: unknown): string {
  return hashExternalState(payload);
}
