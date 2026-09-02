import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobDetailView } from "../components/job-detail-view.js";
import { ApiClient, type Job, type Message } from "../lib/api-client.js";
import { loadJobDetail } from "../lib/load-job-detail.js";

const job: Job = {
  id: "job-12345678",
  personaId: "persona-1",
  parentJobId: null,
  routineId: null,
  depth: 0,
  origin: "user",
  langgraphThreadId: "thread-1",
  status: "done",
  prompt: "Prepare a very long research brief without using this request as the page title.",
  error: null,
  createdAt: "2026-08-30T16:00:00.000Z",
  updatedAt: "2026-08-30T16:00:11.000Z",
  retryEligible: false,
};

const messages: Message[] = [
  {
    id: "message-1",
    jobId: job.id,
    role: "user",
    content: job.prompt ?? "",
    createdAt: job.createdAt,
  },
  {
    id: "message-2",
    jobId: job.id,
    role: "assistant",
    content: "Here is the completed research brief.",
    createdAt: job.updatedAt,
  },
];

describe("JobDetailView", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads persisted messages with the rest of the job details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith(`/jobs/${job.id}`)) return new Response(JSON.stringify(job), { status: 200 });
        if (url.endsWith(`/jobs/${job.id}/messages`)) return new Response(JSON.stringify(messages), { status: 200 });
        if (url.includes("/tool_calls?jobId=")) return new Response("[]", { status: 200 });
        return new Response("not found", { status: 404 });
      }),
    );

    const detail = await loadJobDetail(new ApiClient("http://backend.test", () => "secret"), job.id);

    expect(detail.messages).toEqual(messages);
  });

  it("keeps the request out of the title and renders the persisted conversation", () => {
    const markup = renderToStaticMarkup(
      <JobDetailView job={job} persona={null} messages={messages} toolCalls={[]} transcript={[]} />,
    );

    expect(markup).toContain("<h1");
    expect(markup).toContain(">Job details</h1>");
    expect(markup).toContain(">Request</h2>");
    expect(markup).toContain(job.prompt);
    expect(markup).toContain(">Conversation</h2>");
    expect(markup).toContain("Here is the completed research brief.");
  });

  it("shows the recorded failure reason", () => {
    const markup = renderToStaticMarkup(
      <JobDetailView
        job={{ ...job, status: "failed", error: "The provider rejected the request." }}
        persona={null}
        messages={[]}
        toolCalls={[]}
        transcript={[]}
      />,
    );

    expect(markup).toContain("The provider rejected the request.");
    expect(markup).not.toContain("This job stopped without a recorded reason.");
  });
});
