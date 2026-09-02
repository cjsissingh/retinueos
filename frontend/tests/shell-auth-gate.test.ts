import { describe, expect, it } from "vitest";
import { shouldRenderChrome } from "../lib/shell-auth-gate";

describe("shouldRenderChrome", () => {
  it("never paints chrome on /login or /", () => {
    expect(shouldRenderChrome({ signedOut: true, authChecked: true, authed: true })).toBe(false);
  });

  it("withholds chrome on an app route until the auth check has settled", () => {
    expect(shouldRenderChrome({ signedOut: false, authChecked: false, authed: false })).toBe(false);
  });

  it("withholds chrome on an app route once the auth check confirms no stored password", () => {
    expect(shouldRenderChrome({ signedOut: false, authChecked: true, authed: false })).toBe(false);
  });

  it("paints chrome only once the auth check confirms a stored password", () => {
    expect(shouldRenderChrome({ signedOut: false, authChecked: true, authed: true })).toBe(true);
  });
});
