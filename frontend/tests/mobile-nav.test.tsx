import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MobileNav } from "../components/mobile-nav.js";

describe("MobileNav keyboard visibility", () => {
  it("renders the five-tab bar when the keyboard is not up", () => {
    vi.stubGlobal("React", React);
    const markup = renderToStaticMarkup(
      <MobileNav pathname="/today" pending={0} moreOpen={false} onMoreClick={() => {}} hidden={false} />,
    );
    expect(markup).toContain("Today");
    expect(markup).toContain("More");
    expect(markup).toContain('aria-current="page"');
  });

  it("renders nothing at all while the keyboard occludes it", () => {
    vi.stubGlobal("React", React);
    const markup = renderToStaticMarkup(
      <MobileNav pathname="/today" pending={0} moreOpen={false} onMoreClick={() => {}} hidden={true} />,
    );
    expect(markup).toBe("");
  });

  it("still shows the pending-approvals dot when visible", () => {
    vi.stubGlobal("React", React);
    const markup = renderToStaticMarkup(
      <MobileNav pathname="/approvals" pending={3} moreOpen={false} onMoreClick={() => {}} hidden={false} />,
    );
    expect(markup).toContain("3 pending approvals");
  });
});
