export type ShutdownStep = "http_receiver" | "background_tasks" | "durable_jobs" | "database";

export type ShutdownWork = {
  stopHttpReceiver(): Promise<void>;
  drainBackgroundTasks(): Promise<void>;
  stopDurableJobs(): Promise<void>;
  closeDatabase(): Promise<void>;
  onFailure(step: ShutdownStep, error: unknown): void;
};

/**
 * Stops ingress first, drains both asynchronous boundaries, and always closes
 * the shared database pool. A failure is reported but never prevents later
 * cleanup steps from running.
 */
export async function runGracefulShutdown(work: ShutdownWork): Promise<readonly ShutdownStep[]> {
  const failedSteps: ShutdownStep[] = [];
  const settle = async (step: ShutdownStep, operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      failedSteps.push(step);
      work.onFailure(step, error);
    }
  };

  await settle("http_receiver", work.stopHttpReceiver);
  await Promise.all([
    settle("background_tasks", work.drainBackgroundTasks),
    settle("durable_jobs", work.stopDurableJobs),
  ]);
  await settle("database", work.closeDatabase);
  return failedSteps;
}
