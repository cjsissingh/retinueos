import { describe, expect, it } from "vitest";
import packageMetadata from "../package.json";

describe("package metadata", () => {
  it("keeps the public backend identity and license", () => {
    expect(packageMetadata.name).toBe("retinueos-backend");
    expect(packageMetadata.license).toBe("Apache-2.0");
  });
});
