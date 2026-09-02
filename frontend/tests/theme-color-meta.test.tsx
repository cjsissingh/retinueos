import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThemeColorMeta } from "../components/theme-color-meta.js";

describe("ThemeColorMeta", () => {
  it("pairs the brass light value with the near-black dark value, each scoped to its scheme", () => {
    const markup = renderToStaticMarkup(<ThemeColorMeta />);
    expect(markup).toContain('media="(prefers-color-scheme: light)" content="#8a6a2f"');
    expect(markup).toContain('media="(prefers-color-scheme: dark)" content="#14130f"');
  });
});
