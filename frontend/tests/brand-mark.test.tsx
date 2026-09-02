import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandMark } from "@/components/brand-mark";

describe("BrandMark", () => {
  it("renders one accessible coordinated-group mark at the requested size", () => {
    const markup = renderToStaticMarkup(<BrandMark size={32} title="RetinueOS mark" />);

    expect(markup).toContain('aria-label="RetinueOS mark"');
    expect(markup).toContain('width="32"');
    expect(markup).toContain('height="32"');
    expect(markup.match(/<circle/g)).toHaveLength(3);
  });
});
