import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TechnicalDetails } from "@/components/technical-details";

describe("TechnicalDetails", () => {
  it("keeps implementation data closed until the operator asks for it", () => {
    const markup = renderToStaticMarkup(
      <TechnicalDetails>
        <code>mcp:server:send_email</code>
      </TechnicalDetails>,
    );

    expect(markup).toContain("Technical details");
    expect(markup).toContain("mcp:server:send_email");
    expect(markup).not.toMatch(/<details[^>]*\sopen(?:\s|=|>)/);
    expect(markup).toContain("min-h-11");
  });

  it("supports a more specific disclosure label", () => {
    const markup = renderToStaticMarkup(<TechnicalDetails label="Raw result">payload</TechnicalDetails>);

    expect(markup).toContain("Raw result");
  });
});
