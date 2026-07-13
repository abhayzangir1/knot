import type { Pool } from "pg";

import type { SlackIngressReceipt, SlackIngressReceiptStore } from "../slack/ingress-receipts.js";
import { payloadHash } from "../slack/ingress-receipts.js";

/** A minimal, non-domain delivery receipt that makes retried Slack interactions idempotent. */
export class PostgresSlackIngressReceiptStore implements SlackIngressReceiptStore {
  public constructor(private readonly pool: Pool) {}

  public async claim(receipt: SlackIngressReceipt): Promise<boolean> {
    const hash = payloadHash(receipt.payload);
    const result = await this.pool.query<{ id: string }>(
      `insert into inbound_deliveries (
        delivery_key, source, workspace_slack_team_id, payload_hash, received_at
      ) values ($1, 'slack_interaction', $2, $3, now())
      on conflict (source, delivery_key) do nothing
      returning id`,
      [receipt.deliveryKey, receipt.workspaceSlackTeamId, hash],
    );
    if (result.rows[0]) {
      return true;
    }
    const existing = await this.pool.query<{
      workspace_slack_team_id: string;
      payload_hash: string;
    }>(
      `select workspace_slack_team_id, payload_hash
         from inbound_deliveries
        where source = 'slack_interaction' and delivery_key = $1`,
      [receipt.deliveryKey],
    );
    const row = existing.rows[0];
    if (
      !row ||
      row.workspace_slack_team_id !== receipt.workspaceSlackTeamId ||
      row.payload_hash !== hash
    ) {
      throw new Error(
        "A Slack delivery key was reused with different tenant or payload content; Knot refused the collision.",
      );
    }
    return false;
  }
}
