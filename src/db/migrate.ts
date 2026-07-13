import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { PoolClient } from "pg";

import { loadEnvironment } from "../config/env.js";
import { createDatabase } from "./client.js";

const environment = loadEnvironment();

if (!environment.DATABASE_URL) {
  throw new Error("DATABASE_URL is required to run migrations.");
}

const database = createDatabase(environment.DATABASE_URL);
let migrationLockClient: PoolClient | undefined;

try {
  migrationLockClient = await database.pool.connect();
  await migrationLockClient.query("select pg_advisory_lock(hashtext('knot:migrations:v1'))");
  await migrate(database.db, { migrationsFolder: "drizzle" });
} finally {
  // Destroying this dedicated session releases the session-level advisory lock
  // even when migration throws or the process is shutting down.
  migrationLockClient?.release(true);
  await database.close();
}
