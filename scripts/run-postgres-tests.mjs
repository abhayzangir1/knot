import "dotenv/config";

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

import pg from "pg";

const { Pool } = pg;
const adminUrlValue = process.env.TEST_DATABASE_ADMIN_URL;

if (!adminUrlValue) {
  throw new Error(
    "TEST_DATABASE_ADMIN_URL is required. It must point to an administrative PostgreSQL database, never the Knot runtime database.",
  );
}

const adminUrl = new URL(adminUrlValue);
if (!new Set(["postgres:", "postgresql:"]).has(adminUrl.protocol)) {
  throw new Error("TEST_DATABASE_ADMIN_URL must be a PostgreSQL URL.");
}

const databaseName = `knot_test_${Date.now()}_${randomBytes(6).toString("hex")}`;
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${databaseName}`;

const childEnvironment = {
  ...process.env,
  DATABASE_URL: testUrl.toString(),
  NODE_ENV: "test",
};
delete childEnvironment.SLACK_BOT_TOKEN;
delete childEnvironment.SLACK_SIGNING_SECRET;

const npmCliPath = process.env.npm_execpath;
if (!npmCliPath) {
  throw new Error("Run this helper through `npm run test:postgres` so the npm CLI path is known.");
}
const adminPool = new Pool({ connectionString: adminUrl.toString(), max: 1 });
let databaseCreated = false;

function runNpm(arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npmCliPath, ...arguments_], {
      env: childEnvironment,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Child command failed with ${signal ? `signal ${signal}` : `exit code ${String(code)}`}.`,
        ),
      );
    });
  });
}

try {
  await adminPool.query(`create database "${databaseName}"`);
  databaseCreated = true;
  console.log(`Created isolated PostgreSQL test database ${databaseName}.`);
  await runNpm(["run", "db:migrate"]);
  await runNpm(["test"]);
} finally {
  if (databaseCreated) {
    await adminPool.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
      [databaseName],
    );
    await adminPool.query(`drop database if exists "${databaseName}"`);
    console.log(`Removed isolated PostgreSQL test database ${databaseName}.`);
  }
  await adminPool.end();
}
