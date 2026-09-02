import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PushNudgeStripView } from "../components/push-nudge-strip";

describe("PushNudgeStripView", () => {
  it("offers Get these on your phone for the enable state", () => {
    const markup = renderToStaticMarkup(
      <PushNudgeStripView state="enable" onDismiss={() => undefined} onEnable={() => undefined} />,
    );
    expect(markup).toContain("Get these on your phone");
  });

  it("explains Add to Home Screen for iOS without offering a broken button", () => {
    const markup = renderToStaticMarkup(
      <PushNudgeStripView state="ios_not_installed" onDismiss={() => undefined} onEnable={() => undefined} />,
    );
    expect(markup).toContain("Add to Home Screen");
    expect(markup).not.toContain(">Enable<");
  });

  it("states denial plainly and links to browser settings without a re-prompt button", () => {
    const markup = renderToStaticMarkup(
      <PushNudgeStripView state="denied" onDismiss={() => undefined} onEnable={() => undefined} />,
    );
    expect(markup).toContain("Permission was denied");
    expect(markup).not.toContain(">Enable<");
  });

  it("renders nothing for state none", () => {
    const markup = renderToStaticMarkup(
      <PushNudgeStripView state="none" onDismiss={() => undefined} onEnable={() => undefined} />,
    );
    expect(markup).toBe("");
  });
});
