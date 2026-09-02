import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToastViewport } from "../components/toast";

describe("ToastViewport", () => {
  it("renders every toast up to 3 with no overflow pill", () => {
    const markup = renderToStaticMarkup(
      <ToastViewport
        toasts={[
          { id: 1, message: "one", persist: false },
          { id: 2, message: "two", persist: true },
        ]}
        onDismiss={() => undefined}
      />,
    );
    expect(markup).toContain("one");
    expect(markup).toContain("two");
    expect(markup).not.toContain("more");
  });

  it("collapses a 4th toast into a +N more pill linking to /notifications", () => {
    const markup = renderToStaticMarkup(
      <ToastViewport
        toasts={[
          { id: 1, message: "one", persist: false },
          { id: 2, message: "two", persist: false },
          { id: 3, message: "three", persist: false },
          { id: 4, message: "four", persist: false },
        ]}
        onDismiss={() => undefined}
      />,
    );
    expect(markup).toContain("+1 more");
    expect(markup).toContain('href="/notifications"');
  });
});
