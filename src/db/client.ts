import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema.js";

export type KnotDatabase = NodePgDatabase<typeof schema>;

export type DatabaseHandle = {
  db: KnotDatabase;
  pool: Pool;
  close(): Promise<void>;
};

export function createDatabase(connectionString: string): DatabaseHandle {
  const pool = new Pool({
    connectionString,
    max: 12,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  const db = drizzle({ client: pool, schema });
  return {
    db,
    pool,
    close: () => pool.end(),
  };
}

export async function withWorkspaceTransaction<T>(
  db: KnotDatabase,
  workspaceId: string,
  work: (transaction: KnotDatabase) => Promise<T>,
): Promise<T> {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`);
    return work(transaction as KnotDatabase);
  });
}
