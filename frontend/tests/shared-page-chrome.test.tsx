import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

describe("shared page chrome", () => {
  it("keeps empty states compact and free of decorative filler", () => {
    const markup = renderToStaticMarkup(
      <EmptyState title="You’re all caught up" description="New requests will appear here." />,
    );

    expect(markup).not.toContain("border-dashed");
    expect(markup).not.toContain("<i");
    expect(markup).toContain("max-w");
  });

  it("places a concise description directly under the page title", () => {
    const markup = renderToStaticMarkup(
      <PageHeader eyebrow="Settings" title="Connections" description="Give your staff access to outside services." />,
    );

    expect(markup).toContain("Give your staff access to outside services.");
    expect(markup).not.toContain("border-b");
  });
});
