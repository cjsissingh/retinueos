import { describe, expect, it } from "vitest";
import { ORG_CHART_LAYOUT } from "../components/org-chart.js";

describe("org chart mobile layout", () => {
  it("uses a stacked list on a narrow viewport instead of a shrunk desktop tree", () => {
    expect(ORG_CHART_LAYOUT.mobileList).toContain("md:hidden");
    expect(ORG_CHART_LAYOUT.mobileRow).toContain("min-h-11");
    expect(ORG_CHART_LAYOUT.desktopTree).toContain("hidden");
    expect(ORG_CHART_LAYOUT.desktopTree).toContain("md:block");
    expect(ORG_CHART_LAYOUT.desktopTree).toContain("overflow-x-auto");
    expect(ORG_CHART_LAYOUT.desktopTree).toContain("min-w-0");
  });
});
