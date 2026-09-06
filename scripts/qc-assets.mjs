#!/usr/bin/env node
// Vision QC for generated assets, using qwen3.8-flash (image *input*) on the same
// Qwen token plan that produced the art. This is a cheap automated gate before a
// human uploads anything to @BotFather: it specifically hunts the failure modes
// that text-to-image models produce — garbled lettering, extra limbs/fingers,
// watermarks, banding, and subjects that read badly when scaled down.
//
//   node scripts/qc-assets.mjs                 # check assets/raw
//   node scripts/qc-assets.mjs --imgs photo,banner
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'assets', 'raw');
const KEY = process.env.QWEN_TOKEN_PLAN_API_KEY;
const BASE = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com';
const MODEL = 'qwen3.8-flash';

const CRITERIA = {
  photo: 'bot profile picture, will be shown as small as 48x48 px inside a chat list',
  icon: 'app icon, must read at 32 px',
  banner: 'wide 2:1 banner for the mini app listing',
  preview: 'portrait key art card',
  felt: 'seamless tileable dark green felt texture',
  chipset: 'reference image of casino chip denominations',
};

/** Downscale hard: the critic needs shape and defects, not 2MB of detail. */
async function toDataUri(file, max = 640) {
  const buf = await sharp(file).rotate().resize({ width: max, withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

const want = (process.argv.find((a) => a.startsWith('--imgs=')) ?? '').split('=')[1];
const files = (want ? want.split(',') : readdirSync(RAW).filter((f) => f.endsWith('.png')).map((f) => f.replace(/\.png$/, ''))).filter((n) =>
  readFileSync(join(RAW, `${n}.png`)) && true,
);

const parts = [];
for (const name of files) {
  parts.push({ type: 'text', text: `ASSET "${name}" — purpose: ${CRITERIA[name] ?? 'generic game art'}` });
  parts.push({ type: 'image_url', image_url: { url: await toDataUri(join(RAW, `${name}.png`)) } });
}
parts.push({
  type: 'text',
  text: `You are art-directing assets for a Telegram play-money blackjack mini app.
For EACH asset above, output exactly this shape, nothing else:

ASSET <name>: VERDICT=pass|fail
- defects: <comma-separated list, or "none">
- at_small_size: <does the subject still read when scaled to ~48px? yes|no|n/a>
- fix: <one imperative sentence if verdict is fail, else "-">

Hard fail conditions: any garbled or invented lettering/text, watermark, extra or
missing fingers/limbs, duplicated objects that should be singular, banding, or a
subject that becomes unreadable at small size. Judge only what is visible.`,
});

const res = await fetch(`${BASE}/compatible-mode/v1/chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model: MODEL, max_tokens: 1800, temperature: 0.1, messages: [{ role: 'user', content: parts }] }),
  signal: AbortSignal.timeout(240_000),
});

const json = await res.json().catch(() => null);
if (!res.ok) {
  console.error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 400)}`);
  process.exit(1);
}
const text = json?.choices?.[0]?.message?.content ?? '';
console.log(text.trim());

const failed = [...text.matchAll(/ASSET (\w+): VERDICT=(\w+)/g)].filter((m) => m[2].toLowerCase() === 'fail').map((m) => m[1]);
console.log(`\n${failed.length ? `✖ regenerate: ${failed.join(', ')}` : '✔ all assets passed vision QC'}`);
process.exitCode = failed.length ? 1 : 0;
