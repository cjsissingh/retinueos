import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TranscriptRow } from "../components/transcript-row.js";

describe("TranscriptRow", () => {
  it("keeps a nested tool payload inside a closed technical-details disclosure", () => {
    // This catches replacing the compact tool activity rendering with an eager
    // debug dump in the conversation transcript.
    const markup = renderToStaticMarkup(
      <TranscriptRow
        entry={{
          key: "tool-1",
          kind: "tool_result",
          at: Date.now(),
          data: {
            toolId: "gmail_search",
            arguments: {
              query: "invoices",
              debug: { traceId: "trace-secret", nested: ["unbounded", "payload"] },
            },
            result: {
              summary: "3 matching messages",
              messages: [{ id: "message-1", headers: { subject: "Invoice" } }],
            },
          },
        }}
      />,
    );

    const compactTranscript = markup.split("<details")[0];
    expect(compactTranscript).toContain("Search Gmail");
    expect(compactTranscript).toContain("3 matching messages");
    expect(markup).toContain("Technical details");
    expect(markup).toContain("trace-secret");
    expect(markup).toMatch(/<details[^>]*>/);
    expect(markup).not.toMatch(/<details[^>]*\sopen(?:\s|=|>)/);
  });

  it("shows MCP text results before request arguments in the compact transcript", () => {
    // This catches falling back to an MCP request's arguments when its useful
    // `{ content: [{ type: "text", text }] }` result has no summary field.
    const markup = renderToStaticMarkup(
      <TranscriptRow
        entry={{
          key: "tool-mcp",
          kind: "tool_result",
          at: Date.now(),
          data: {
            toolId: "gmail_search",
            arguments: { query: "old invoices" },
            result: { content: [{ type: "text", text: "Found 2 matching invoices." }] },
          },
        }}
      />,
    );

    const compactTranscript = markup.split("<details")[0];
    expect(compactTranscript).toContain("Found 2 matching invoices.");
    expect(compactTranscript).not.toContain("Query: old invoices");
  });

  it("shows native state content before request arguments in the compact transcript", () => {
    // This catches hiding a native `{ key, content }` result behind Technical
    // details and presenting only the request key instead.
    const markup = renderToStaticMarkup(
      <TranscriptRow
        entry={{
          key: "tool-state",
          kind: "tool_result",
          at: Date.now(),
          data: {
            toolId: "read_state",
            arguments: { key: "preferences" },
            result: { key: "preferences", content: "Vegetarian lunches are preferred." },
          },
        }}
      />,
    );

    const compactTranscript = markup.split("<details")[0];
    expect(compactTranscript).toContain("Vegetarian lunches are preferred.");
    expect(compactTranscript).not.toContain("Key: preferences");
  });

  it("drops the risk-coloured border with framed={false} while keeping the risk badge", () => {
    // the persona chat transcript renders every tool row unframed
    // -- the approval card is the only bordered element there -- but still
    // wants the risk badge as the fallback signal for a destructive call.
    const markup = renderToStaticMarkup(
      <TranscriptRow
        framed={false}
        entry={{
          key: "tool-unframed",
          kind: "tool_result",
          at: Date.now(),
          data: { toolId: "send_email", arguments: { to: "a@b.com" }, result: {} },
        }}
      />,
    );
    expect(markup).not.toContain("border-left-color");
    expect(markup).toContain("Destructive");
  });
});
