import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RiskFrame } from "../components/risk-frame.js";

describe("RiskFrame", () => {
  it("draws the risk-coloured border by default", () => {
    const markup = renderToStaticMarkup(
      <RiskFrame riskClass="destructive">
        <span>content</span>
      </RiskFrame>,
    );
    expect(markup).toContain("border-left-color");
  });

  it("renders unframed -- the persona chat transcript, where the approval card is the only bordered element", () => {
    const markup = renderToStaticMarkup(
      <RiskFrame riskClass="destructive" framed={false}>
        <span>content</span>
      </RiskFrame>,
    );
    expect(markup).not.toContain("border-left-color");
    expect(markup).not.toContain("border-color");
    expect(markup).toContain("content");
  });
});
