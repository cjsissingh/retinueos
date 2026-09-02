import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AuthFrame } from "@/components/auth-frame";

describe("AuthFrame", () => {
  it("uses the shared RetinueOS identity and semantic theme tokens", () => {
    const markup = renderToStaticMarkup(
      <AuthFrame title="Welcome back" description="Your staff are waiting.">
        <button type="button">Continue</button>
      </AuthFrame>,
    );

    expect(markup).toContain("RetinueOS mark");
    expect(markup).toContain("Welcome back");
    expect(markup).toContain("Your staff are waiting.");
    expect(markup).toContain("bg-bg");
    expect(markup).not.toContain("#14130f");
  });
});
