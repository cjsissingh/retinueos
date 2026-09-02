import { describe, expect, it } from "vitest";
import { TODAY_LAYOUT } from "../lib/today-layout.js";

describe("today layout contract", () => {
  it("caps the single column at ~720px per design guide", () => {
    expect(TODAY_LAYOUT.page).toContain("max-w-[720px]");
  });

  it("uses tighter page padding on a narrow viewport", () => {
    expect(TODAY_LAYOUT.page).toContain("px-4");
    expect(TODAY_LAYOUT.page).toContain("sm:px-8");
  });
});
