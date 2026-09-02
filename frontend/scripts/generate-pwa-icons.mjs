#!/usr/bin/env node
/**
 * Generate RetinueOS PWA icons.
 *
 * `any` (iOS Home Screen, most launchers): full-bleed brass. The OS applies
 * its own mask (squircle, circle, rounded rect). Pre-drawing a rounded square
 * on cream is what made Android circles show a square-in-a-circle.
 *
 * `maskable` (Android adaptive): the same full-bleed brass so every mask
 * shape is solid brand color. There is no edge-critical artwork, so the 80%
 * safe zone is satisfied without a padded cream frame.
 */
import { createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const BRASS = [0x8a, 0x6a, 0x2f];
const DIR = join(dirname(fileURLToPath(import.meta.url)), "../public/icons");

function crc32(buf) {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let b = 0; b < 8; b++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return ~crc >>> 0;
}

function chunk(tag, data) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(tag, 4, 4, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([Buffer.from(tag, "ascii"), data])), 0);
  return Buffer.concat([header, data, crcBuf]);
}

function writePng(path, size, rgb) {
  const raw = Buffer.alloc((1 + size * 3) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const i = row + 1 + x * 3;
      raw[i] = rgb[0];
      raw[i + 1] = rgb[1];
      raw[i + 2] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  createWriteStream(path).end(png);
}

const files = [
  ["retinueos-180.png", 180],
  ["retinueos-192.png", 192],
  ["retinueos-512.png", 512],
  ["retinueos-maskable-192.png", 192],
  ["retinueos-maskable-512.png", 512],
];

for (const [name, size] of files) {
  writePng(join(DIR, name), size, BRASS);
  console.log("wrote", name);
}
