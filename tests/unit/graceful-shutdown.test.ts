import { describe, expect, it, vi } from "vitest";

import { runGracefulShutdown } from "../../src/runtime/graceful-shutdown.js";

describe("graceful runtime shutdown", () => {
  it("stops ingress before draining work and closes the database last", async () => {
    const order: string[] = [];

    const failed = await runGracefulShutdown({
      stopHttpReceiver: async () => {
        order.push("http");
      },
      drainBackgroundTasks: async () => {
        order.push("background");
      },
      stopDurableJobs: async () => {
        order.push("jobs");
      },
      closeDatabase: async () => {
        order.push("database");
      },
      onFailure: vi.fn(),
    });

    expect(failed).toEqual([]);
    expect(order[0]).toBe("http");
    expect(new Set(order.slice(1, 3))).toEqual(new Set(["background", "jobs"]));
    expect(order[3]).toBe("database");
  });

  it("attempts every cleanup step and reports failures without rejecting", async () => {
    const attempted: string[] = [];
    const onFailure = vi.fn();
    const failure = new Error("simulated shutdown failure");

    const failed = await runGracefulShutdown({
      stopHttpReceiver: async () => {
        attempted.push("http");
        throw failure;
      },
      drainBackgroundTasks: async () => {
        attempted.push("background");
      },
      stopDurableJobs: async () => {
        attempted.push("jobs");
        throw failure;
      },
      closeDatabase: async () => {
        attempted.push("database");
      },
      onFailure,
    });

    expect(failed).toEqual(["http_receiver", "durable_jobs"]);
    expect(attempted).toEqual(expect.arrayContaining(["http", "background", "jobs", "database"]));
    expect(onFailure).toHaveBeenCalledTimes(2);
    expect(onFailure).toHaveBeenCalledWith("http_receiver", failure);
    expect(onFailure).toHaveBeenCalledWith("durable_jobs", failure);
  });
});
