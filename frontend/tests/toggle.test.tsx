import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Toggle } from "../components/ui/toggle";

describe("Toggle", () => {
  it("renders as an ARIA switch, not a checkbox", () => {
    const markup = renderToStaticMarkup(<Toggle checked={false} onChange={() => undefined} label="Example" />);
    expect(markup).not.toContain('type="checkbox"');
    expect(markup).toContain('role="switch"');
    expect(markup).toContain('aria-label="Example"');
  });

  it("reflects the checked state via aria-checked", () => {
    const on = renderToStaticMarkup(<Toggle checked={true} onChange={() => undefined} label="On" />);
    const off = renderToStaticMarkup(<Toggle checked={false} onChange={() => undefined} label="Off" />);
    expect(on).toContain('aria-checked="true"');
    expect(off).toContain('aria-checked="false"');
  });

  it("disables the control without hiding its current state", () => {
    const markup = renderToStaticMarkup(<Toggle checked={true} disabled onChange={() => undefined} label="Forced" />);
    expect(markup).toContain("disabled=");
    expect(markup).toContain('aria-checked="true"');
  });
});
