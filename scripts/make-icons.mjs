#!/usr/bin/env node
// Regenerate web/icons/*.png — the PWA/manifest icons. Renders the padlock
// SVG below in headless Chromium, so no image toolchain is needed and the
// output is identical everywhere. The art is deliberately full-bleed with
// the lock inside the central safe zone, so the same files work for both
// "any" and "maskable" icon purposes (see web/manifest.webmanifest).
//
// Usage: PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core node scripts/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { loadPlaywright } from './pw.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const outDir = path.join(root, 'web', 'icons');

// Colors follow web/styles.css: accent gradient background, light lock.
// The lock is drawn on a 512 canvas, then scaled about its center into
// the maskable safe zone (a circle of radius 40% of the icon size), so
// the same full-bleed file works for both "any" and "maskable" purposes
// — see web/manifest.webmanifest.
const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" style="width:100%;height:100%;display:block">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#3d7ddd"/>
      <stop offset="1" stop-color="#1a4176"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <g transform="translate(256 268) scale(.84) translate(-256 -256)">
    <path d="M168 232v-64a88 88 0 0 1 176 0v64" fill="none" stroke="#e6ebf2" stroke-width="44" stroke-linecap="round"/>
    <rect x="136" y="224" width="240" height="196" rx="36" fill="#e6ebf2"/>
    <circle cx="256" cy="308" r="30" fill="#1a4176"/>
    <rect x="242" y="320" width="28" height="56" rx="14" fill="#1a4176"/>
  </g>
</svg>`;

fs.mkdirSync(outDir, { recursive: true });
const { chromium } = loadPlaywright();
const browser = await chromium.launch({ headless: true });
for (const size of [192, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<body style="margin:0">${SVG}</body>`);
  await page.waitForTimeout(100); // let the paint settle
  const out = path.join(outDir, `icon-${size}.png`);
  await page.screenshot({ path: out });
  await page.close();
  console.log(`wrote web/icons/icon-${size}.png`);
}
await browser.close();
