import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastItem, ToastViewport } from "../components/toast";

describe("ToastItem", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
  });

  it("renders an actionable toast as a link to its destination", () => {
    const toast = ToastItem({ message: "Job finished", href: "/logs/job-1" });

    expect(toast.type).toBe("a");
    expect(toast.props.href).toBe("/logs/job-1");
  });

  it("renders a passive toast as non-interactive content", () => {
    const toast = ToastItem({ message: "Saved" });

    expect(toast.type).toBe("div");
    expect(toast.props).not.toHaveProperty("href");
  });

  it("announces asynchronous toast updates politely", () => {
    const viewport = ToastViewport({ toasts: [] });

    expect(viewport.props["aria-live"]).toBe("polite");
  });

  it("hides the decorative status dot from assistive technology", () => {
    const toast = ToastItem({ message: "Saved" });

    expect(toast.props.children.props.children[0].props["aria-hidden"]).toBe("true");
  });
});
