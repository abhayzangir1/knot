import { WebClient } from "@slack/web-api";

import { loadEnvironment, requireSlackEnvironment } from "./config/env.js";
import { createDatabase } from "./db/client.js";
import { PostgresInteractionContextStore } from "./db/interaction-context-store.js";
import { PostgresOutcomeStore } from "./db/outcome-store.js";
import { PostgresSlackIngressReceiptStore } from "./db/slack-ingress-receipt-store.js";
import { PostgresActorIdentityResolver } from "./identity/resolver.js";
import { PostgresDurableJobQueue } from "./jobs/durable-job-queue.js";
import { createLogger } from "./observability/logger.js";
import { runGracefulShutdown } from "./runtime/graceful-shutdown.js";
import { OutcomeService } from "./services/outcome-service.js";
import { createKnotSlackApp } from "./slack/app.js";

const environment = loadEnvironment();
const logger = createLogger(environment);
const slackEnvironment = requireSlackEnvironment(environment);

if (!environment.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required. Knot never runs the Slack walking skeleton on in-memory state.",
  );
}

const slackAuthentication = await new WebClient(slackEnvironment.SLACK_BOT_TOKEN).auth.test();
const expectedSlackTeamId = slackAuthentication.team_id;
if (!expectedSlackTeamId) {
  throw new Error("Slack auth.test did not return the installed workspace ID.");
}
const database = createDatabase(environment.DATABASE_URL);
const jobs = new PostgresDurableJobQueue(database.pool, logger);
const { app, drainBackgroundTasks, startDurableJobs, stopDurableJobs } = createKnotSlackApp({
  environment,
  expectedSlackTeamId,
  logger,
  identities: new PostgresActorIdentityResolver(database.pool),
  outcomeService: new OutcomeService(new PostgresOutcomeStore(database.pool)),
  interactions: new PostgresInteractionContextStore(database.pool),
  ingress: new PostgresSlackIngressReceiptStore(database.pool),
  jobs,
  healthCheck: async () => {
    await database.pool.query("select 1");
    await jobs.healthCheck();
  },
});

try {
  await database.pool.query("select 1");
  await app.start(environment.PORT);
  startDurableJobs();
} catch (error) {
  await stopDurableJobs().catch(() => undefined);
  await app.stop().catch(() => undefined);
  await database.close();
  throw error;
}
logger.info({ port: environment.PORT }, "Knot Slack HTTP receiver started");

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  logger.info({ signal }, "Knot is stopping");

  const failedSteps = await runGracefulShutdown({
    stopHttpReceiver: async () => {
      await app.stop();
    },
    drainBackgroundTasks,
    stopDurableJobs,
    closeDatabase: database.close,
    onFailure: (step, error) => logger.error({ err: error, step }, "Knot shutdown step failed"),
  });

  if (failedSteps.length > 0) {
    process.exitCode = 1;
    logger.error({ failedSteps }, "Knot stopped with incomplete cleanup");
  }
}

function requestStop(signal: string): void {
  void stop(signal).catch((error) => {
    process.exitCode = 1;
    logger.error({ err: error, signal }, "Knot shutdown failed unexpectedly");
  });
}

process.once("SIGINT", () => requestStop("SIGINT"));
process.once("SIGTERM", () => requestStop("SIGTERM"));
