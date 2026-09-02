import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SegmentedControl } from "@/components/ui/segmented-control";

describe("SegmentedControl", () => {
  it("renders visible, equal-width, touch-sized choices", () => {
    const markup = renderToStaticMarkup(
      <SegmentedControl
        label="Weather permission"
        value="ask"
        options={[
          { value: "allow", label: "Allow" },
          { value: "ask", label: "Ask" },
          { value: "blocked", label: "Block" },
        ]}
        onChange={() => undefined}
      />,
    );

    expect(markup).toContain('role="radiogroup"');
    expect(markup).toContain('aria-label="Weather permission"');
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain("grid-cols-3");
    expect(markup).toContain("min-h-11");
    expect(markup).toContain(">Allow<");
    expect(markup).toContain(">Ask<");
    expect(markup).toContain(">Block<");
    expect(markup).not.toContain("overflow-hidden");
  });

  it("uses two columns for a two-option control", () => {
    const markup = renderToStaticMarkup(
      <SegmentedControl
        label="Log kind"
        value="jobs"
        options={[
          { value: "jobs", label: "Jobs" },
          { value: "digests", label: "Digests" },
        ]}
        onChange={() => undefined}
      />,
    );
    expect(markup).toContain("grid-cols-2");
    expect(markup).not.toContain("grid-cols-3");
  });
});
