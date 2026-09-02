import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { DrizzleDb } from "../src/db/client.js";
import { JobEventBus } from "../src/orchestration/event-bus.js";
import { streamRoutes } from "../src/stream/stream-routes.js";

describe("job stream subscription ordering", () => {
  it("re-reads after subscribing when a terminal event lands between the initial snapshot and subscription", async () => {
    const jobId = "00000000-0000-0000-0000-000000000001";
    const statuses = ["running", "done"];
    let reads = 0;
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: async () => [
            {
              id: jobId,
              status: statuses[reads++]!,
            },
          ],
        }),
      }),
    } as DrizzleDb;

    class PublishBeforeSubscribeBus extends JobEventBus {
      override subscribe(job: string, handler: Parameters<JobEventBus["subscribe"]>[1]): () => void {
        // Simulates completion after the route's first SELECT but just before
        // its listener is installed. This publication is intentionally lost;
        // the post-subscription snapshot must still observe `done` and close.
        this.publish(job, { type: "status", status: "done" });
        return super.subscribe(job, handler);
      }
    }

    const app = new Hono();
    app.route("/", streamRoutes(fakeDb, new PublishBeforeSubscribeBus()));

    const response = await app.request(`/jobs/${jobId}/stream`);
    const reader = response.body!.getReader();
    const result = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
    ]);

    expect(result).not.toBeNull();
    expect(new TextDecoder().decode(result!.value)).toContain('"status":"done"');
    expect(reads).toBe(2);
  });
});
