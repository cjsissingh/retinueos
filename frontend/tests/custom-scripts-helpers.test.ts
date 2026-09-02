import { describe, expect, it } from "vitest";
import {
  customScriptDisplayName,
  isValidToolKey,
  parseListInput,
} from "../app/settings/custom-scripts/custom-scripts-content";

describe("customScriptDisplayName", () => {
  it("turns a storage key into a readable script name", () => {
    expect(customScriptDisplayName("weather_scraper")).toBe("Weather scraper");
  });
});

describe("isValidToolKey", () => {
  it("accepts a lowercase slug", () => {
    expect(isValidToolKey("weather-scraper")).toBe(true);
  });

  it("rejects an uppercase or space-containing value", () => {
    expect(isValidToolKey("Not Valid")).toBe(false);
  });

  it("rejects a value not starting with a letter", () => {
    expect(isValidToolKey("1-scraper")).toBe(false);
  });
});

describe("parseListInput", () => {
  it("splits a comma-separated string and trims each entry", () => {
    expect(parseListInput("example.com, api.example.com ,, other.com")).toEqual([
      "example.com",
      "api.example.com",
      "other.com",
    ]);
  });

  it("returns an empty array for blank input", () => {
    expect(parseListInput("   ")).toEqual([]);
  });
});
