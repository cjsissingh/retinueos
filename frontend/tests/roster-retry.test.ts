import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// No jsdom / @testing-library/react is set up anywhere in this project
// (grep confirms there's no `render(`, `act(`, or `react-dom/client` usage
// in tests/), and this page's terminal-status blocks only ever populate
// after an on-mount `load()` effect -- renderToStaticMarkup (the harness
// job-detail.test.tsx uses) doesn't run effects, so that branch is
// unreachable in static markup too. Following persona-management-source
// .test.ts's precedent instead: assert on the page's source text for the
// specific wiring a real click needs (disabled/title bound to
// retryEligible/retryBlockedReason, onClick wired to retryActiveJob) in
// both terminal-status blocks, and that retryActiveJob calls client.retryJob
// with the active job's id.
const chatPage = readFileSync(new URL("../app/roster/[personaId]/page.tsx", import.meta.url), "utf8");

describe("chat transcript Retry button", () => {
  it("wires retryActiveJob to client.retryJob keyed on the active job", () => {
    expect(chatPage).toContain("await client.retryJob(activeJob.id, idempotencyKey)");
  });

  it("gives the failed block a Retry button disabled with the blocked reason as its title", () => {
    const failedBlock = chatPage.slice(chatPage.indexOf('activeJob.status === "failed" &&'));
    const button = failedBlock.slice(0, failedBlock.indexOf("</button>"));
    expect(button).toContain("disabled={!activeJob.retryEligible || retryingJob}");
    expect(button).toContain("title={activeJob.retryEligible ? undefined : activeJob.retryBlockedReason}");
    expect(button).toContain("onClick={retryActiveJob}");
    expect(button).toContain('{retryingJob ? "Retrying…" : "Retry"}');
  });

  it("gives the cancelled|timed_out|outcome_unknown block the same Retry treatment", () => {
    const terminalBlock = chatPage.slice(chatPage.indexOf('activeJob.status === "cancelled" ||'));
    const button = terminalBlock.slice(0, terminalBlock.indexOf("</button>"));
    expect(button).toContain("disabled={!activeJob.retryEligible || retryingJob}");
    expect(button).toContain("title={activeJob.retryEligible ? undefined : activeJob.retryBlockedReason}");
    expect(button).toContain("onClick={retryActiveJob}");
    expect(button).toContain('{retryingJob ? "Retrying…" : "Retry"}');
  });
});
