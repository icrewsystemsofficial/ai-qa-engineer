#!/usr/bin/env node
// Verifies the supplied AI QA Engineer raster icons used by the manifest.
//
// Usage: node scripts/generate-icons.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { access } from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const ICON_DIR = resolve(REPO, "public/icon");
const ICONS = [
  "favicon-16x16.png",
  "favicon-32x32.png",
  "android-chrome-192x192.png",
  "android-chrome-512x512.png",
];

async function main() {
  await Promise.all(ICONS.map((icon) => access(resolve(ICON_DIR, icon))));
  console.log(`✓ verified ${ICONS.length} AI QA Engineer icon files`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
