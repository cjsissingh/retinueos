import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import manifest from "../app/manifest.js";

const BRASS = [0x8a, 0x6a, 0x2f];
const CREAM = [0xf7, 0xf5, 0xf1];
const ICONS = join(import.meta.dirname ?? __dirname, "../public/icons");

function pngCorner(path: string): number[] {
  const buf = readFileSync(path);
  let offset = 8;
  let idat = Buffer.alloc(0);
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === "IDAT") idat = Buffer.concat([idat, data]);
    offset += 12 + length;
  }
  const raw = inflateSync(idat);
  // Filter byte, then first pixel RGB.
  return [raw[1], raw[2], raw[3]];
}

function pngPixel(path: string, xRatio: number, yRatio: number): number[] {
  const buf = readFileSync(path);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  let offset = 8;
  let idat = Buffer.alloc(0);
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === "IDAT") idat = Buffer.concat([idat, data]);
    offset += 12 + length;
  }
  const raw = inflateSync(idat);
  const stride = width * 3;
  const pixels = Buffer.alloc(stride * height);
  let rawOffset = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = raw[rawOffset] ?? 0;
    rawOffset += 1;
    for (let column = 0; column < stride; column += 1) {
      const source = raw[rawOffset + column] ?? 0;
      const left = column >= 3 ? (pixels[row * stride + column - 3] ?? 0) : 0;
      const above = row > 0 ? (pixels[(row - 1) * stride + column] ?? 0) : 0;
      const upperLeft = row > 0 && column >= 3 ? (pixels[(row - 1) * stride + column - 3] ?? 0) : 0;
      let prediction = 0;
      if (filter === 1) prediction = left;
      else if (filter === 2) prediction = above;
      else if (filter === 3) prediction = Math.floor((left + above) / 2);
      else if (filter === 4) prediction = paeth(left, above, upperLeft);
      pixels[row * stride + column] = (source + prediction) & 0xff;
    }
    rawOffset += stride;
  }
  const x = Math.floor(width * xRatio);
  const y = Math.floor(height * yRatio);
  const pixel = y * stride + x * 3;
  return [pixels[pixel], pixels[pixel + 1], pixels[pixel + 2]];
}

function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  if (aboveDistance <= upperLeftDistance) return above;
  return upperLeft;
}

describe("PWA install icons", () => {
  it("separates any and maskable purposes so Android does not crop a pre-drawn square", () => {
    const icons = manifest().icons ?? [];
    const anyIcons = icons.filter((icon) => icon.purpose === "any");
    const maskable = icons.filter((icon) => icon.purpose === "maskable");
    expect(anyIcons.length).toBeGreaterThanOrEqual(2);
    expect(maskable.length).toBeGreaterThanOrEqual(2);
    expect(maskable.every((icon) => icon.src?.includes("maskable"))).toBe(true);
    expect(anyIcons.every((icon) => !icon.src?.includes("maskable"))).toBe(true);
  });

  it("uses full-bleed brass so OS masks (circle or squircle) stay on-brand", () => {
    for (const name of ["retinueos-192.png", "retinueos-512.png", "retinueos-maskable-512.png", "retinueos-180.png"]) {
      const [r, g, b] = pngCorner(join(ICONS, name));
      expect([r, g, b]).toEqual(BRASS);
      expect([r, g, b]).not.toEqual(CREAM);
    }
  });

  it("renders the coordinated-group mark instead of a featureless brass square", () => {
    for (const name of ["retinueos-192.png", "retinueos-512.png", "retinueos-maskable-512.png", "retinueos-180.png"]) {
      expect(pngPixel(join(ICONS, name), 0.5, 0.66)).toEqual(CREAM);
      expect(pngPixel(join(ICONS, name), 0.43, 0.49)).toEqual(CREAM);
    }
  });
});
