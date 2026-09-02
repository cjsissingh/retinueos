import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { useTestDb } from "./setup/db.js";
import { createPersona } from "../src/personas/persona-repo.js";
import { createRoutine, getRoutine } from "../src/personas/routine-repo.js";
import { PersonaScheduler } from "../src/orchestration/scheduler.js";
import { JobWorker } from "../src/orchestration/job-worker.js";
import { listNotifications } from "../src/notifications/notify.js";
import { listNotificationDeliveries } from "../src/notifications/delivery-repo.js";
import { upsertPushSubscription } from "../src/notifications/push-subscription-repo.js";
import { updateQuietHours } from "../src/notifications/notification-quiet-hours-repo.js";
import { resetSettingsCache } from "../src/config.js";
import { defaultRegistry } from "../src/tools/registry.js";

const sendWebPush = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../src/notifications/web-push-transport.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/notifications/web-push-transport.js")>();
  return { ...actual, sendWebPush };
});

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: vi.fn() };
});
const { generateText } = await import("ai");

const { db } = useTestDb();

function enableWebPush() {
  process.env.VAPID_PUBLIC_KEY = "public-key";
  process.env.VAPID_PRIVATE_KEY = "private-key";
  process.env.VAPID_SUBJECT = "mailto:owner@example.com";
  resetSettingsCache();
}

async function enrollDevice() {
  await upsertPushSubscription(db(), {
    endpoint: "https://push.example.test/routine-device",
    p256dh: "p256dh",
    auth: "auth",
  });
}

async function makeRoutine(notifyRoutineRan: boolean) {
  const persona = await createPersona(db(), {
    name: "Rainer",
    role: "Fitness coach",
    systemPrompt: "S",
    modelProvider: "anthropic",
    modelName: "m",
    assignedToolIds: [],
  });
  const routine = await createRoutine(db(), {
    personaId: persona.id,
    name: "Fitness Check",
    cronSchedule: "30 20 * * *",
    promptTemplate: "Check for 3+ days of silence.",
    notifyRoutineRan,
  });
  return { persona, routine };
}

async function fireAndSettle(routineId: string) {
  const scheduler = new PersonaScheduler(db(), defaultRegistry, undefined);
  await scheduler.runNow(routineId);
  const worker = new JobWorker({ db: db(), registry: defaultRegistry, concurrency: 1 });
  await worker.runOnce();
}

describe("routine completion notifyOnOutcome (production worker path)", () => {
  beforeEach(async () => {
    sendWebPush.mockReset().mockResolvedValue(undefined);
    enableWebPush();
    // This path runs `notify()` for real (no `now` override available from
    // here), and the default quiet-hours row is enabled 22:00-07:00
    // server-local -- without disabling it, every push in this describe
    // block silently vanishes for 9 hours a day server-local, reliably
    // reproduced in CI (UTC).
    await updateQuietHours(db(), { enabled: false });
  });

  afterEach(() => {
    delete process.env.NOTIFY_WEBHOOK_URL;
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
    resetSettingsCache();
  });

  it("writes routine.lastSummary and does not push when notifyRoutineRan is false", async () => {
    const { persona, routine } = await makeRoutine(false);
    await enrollDevice();
    vi.mocked(generateText).mockResolvedValueOnce({ text: "All good, logged today.", toolCalls: [] } as never);

    await fireAndSettle(routine.id);

    const updated = await getRoutine(db(), routine.id);
    expect(updated?.lastSummary).toBe("All good, logged today.");

    const forPersona = (await listNotifications(db())).filter((n) => n.personaId === persona.id);
    expect(forPersona).toHaveLength(0);
    expect(sendWebPush).not.toHaveBeenCalled();
  });

  it("creates a web-push delivery when an opted-in routine succeeds", async () => {
    const { persona, routine } = await makeRoutine(true);
    await enrollDevice();
    vi.mocked(generateText).mockResolvedValueOnce({
      text: "3 days of silence on the fitness log.",
      toolCalls: [],
    } as never);

    await fireAndSettle(routine.id);

    const notifications = (await listNotifications(db())).filter((n) => n.personaId === persona.id);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.message).toContain("finished");
    expect(notifications[0]!.message).toContain("3 days of silence");
    expect(notifications[0]!.urgent).toBe(false);

    expect(sendWebPush).toHaveBeenCalledOnce();
    const deliveries = await listNotificationDeliveries(db(), notifications[0]!.id);
    expect(deliveries).toEqual([expect.objectContaining({ transport: "web_push", status: "delivered" })]);
  });

  it("creates a web-push delivery when an opted-in routine fails", async () => {
    const { persona, routine } = await makeRoutine(true);
    await enrollDevice();
    vi.mocked(generateText).mockRejectedValueOnce(new Error("provider exploded"));

    await fireAndSettle(routine.id);

    const notifications = (await listNotifications(db())).filter((n) => n.personaId === persona.id);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.message).toMatch(/failed/i);
    expect(notifications[0]!.message).toContain("provider exploded");
    expect(notifications[0]!.urgent).toBe(true);

    expect(sendWebPush).toHaveBeenCalledOnce();
    const deliveries = await listNotificationDeliveries(db(), notifications[0]!.id);
    expect(deliveries).toEqual([expect.objectContaining({ transport: "web_push", status: "delivered" })]);
  });
});
