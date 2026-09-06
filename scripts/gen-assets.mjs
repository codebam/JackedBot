#!/usr/bin/env node
// =============================================================================
// Bot asset generator.
//
// Art is *generated* by wan2.7-image on the Qwen token-plan (a text-to-image
// model), then derived locally with sharp into the exact sizes @BotFather and
// the Worker's static assets need. Generated art is kept text-free on purpose:
// diffusion models garble lettering, and a bot photo is read at ~48px on a phone,
// so an emblem beats an illustration there. The wordmark is added by the SVG
// overlay path instead, where text is exact.
//
//   node scripts/gen-assets.mjs              # generate + derive everything
//   node scripts/gen-assets.mjs --only photo,icon
//   node scripts/gen-assets.mjs --no-gen     # re-derive from cached raw art
//
// Output:
//   assets/raw/          original generations (kept for re-derivation)
//   assets/botfather/    files you upload to @BotFather
//   public/              favicon, apple-touch-icon, og image, felt texture
// =============================================================================
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'assets', 'raw');
const BF = join(ROOT, 'assets', 'botfather');
const PUB = join(ROOT, 'public');
for (const d of [RAW, BF, join(PUB, 'icons'), join(PUB, 'textures')]) mkdirSync(d, { recursive: true });

const API_KEY = process.env.QWEN_TOKEN_PLAN_API_KEY;
const BASE = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com';
const MODEL = process.env.WAN_MODEL || 'wan2.7-image';

if (!API_KEY) {
  console.error('QWEN_TOKEN_PLAN_API_KEY is not set.');
  process.exit(2);
}

const BRAND = {
  feltDeep: '#061410',
  felt: '#0c1f17',
  feltLit: '#17422a',
  gold: '#f2c66d',
  goldDeep: '#b98a2e',
  cream: '#f6efe0',
  red: '#e8564f',
};

// ---------------------------------------------------------------- art prompts
// Negative prompt is passed through; wan rejects some phrasings, so keep it plain.
const NEG = 'text, letters, words, alphabet, inscriptions, printed labels, engraved writing, gibberish lettering, watermark, logo lettering, signature, ui, screenshot, frame border, hands, faces, extra fingers, low resolution, blur, oversaturated, noise';

const SHOTS = {
  photo: {
    size: '1024*1024',
    prompt:
      'App icon emblem for a blackjack game: a single glossy gold playing-card spade symbol centered on deep emerald green felt, ' +
      'two overlapping playing cards behind it seen from above, subtle radial spotlight, thin gold ring border, ' +
      'flat vector-style illustration, crisp edges, high contrast, symmetrical, minimal, premium casino branding, dark background',
  },
  icon: {
    size: '1024*1024',
    prompt:
      'Tiny monochrome-style emblem: one gold ace of spades playing card, dead center, on a dark emerald circle, ' +
      'flat vector graphic, thick clean outlines, no gradients except a soft inner glow, reads clearly at 32 pixels, minimal',
  },
  banner: {
    // v2: the first generation painted fake inscriptions around the felt rim
    // ("CALTC BOB... BLON"). A plain unmarked surface plus an explicit negative
    // on lettering is what actually removes it.
    size: '1440*720',
    prompt:
      'Wide cinematic banner: a completely plain unmarked emerald green felt surface, no printed lines, no inscriptions, no logos, ' +
      'no lettering of any kind on the felt. Scattered gold and red poker chips with clean blank faces, three playing cards face up ' +
      '(two aces and one jack) resting on the felt, dramatic warm spotlight from above, deep shadow at the edges, ' +
      'moody dark emerald palette with gold highlights, painterly digital illustration',
  },
  preview: {
    // v2: the first attempt rendered playing cards, and the model corrupted their
    // corner indices into invented ranks. Card faces are the one thing this prompt
    // must avoid, so the composition is chips and felt only.
    size: '720*1280',
    prompt:
      'Portrait key art, vertical composition, no playing cards anywhere: a cascade of gold and red poker chips with clean blank faces ' +
      'tumbling down through a shaft of warm light onto plain unmarked emerald green felt, motion blur on the falling chips, ' +
      'dark cinematic lighting, rich green and gold palette, dramatic vignette, painterly digital illustration',
  },
  felt: {
    size: '1024*1024',
    prompt:
      'Seamless tileable texture of dark emerald green felt fabric, fine woven fibre detail, very subtle noise, even flat lighting, ' +
      'photographic macro, desaturated, no objects, no vignette',
  },
  chipset: {
    size: '1024*1024',
    prompt:
      'Five casino poker chips stacked and fanned on dark green felt: white, red, blue, black and gold, glossy edges with dashed rim markings, ' +
      'studio lighting, product photography, no text or numbers on the chips, clean',
  },
};

// --------------------------------------------------------------------- client
async function generate(name, spec) {
  const out = join(RAW, `${name}.png`);
  if (existsSync(out) && process.argv.includes('--no-gen')) {
    return out;
  }
  console.log(`  generating ${name} (${spec.size}) with ${MODEL}…`);
  const res = await fetch(`${BASE}/api/v1/services/aigc/multimodal-generation/generation`, {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      input: { messages: [{ role: 'user', content: [{ text: spec.prompt }] }] },
      parameters: { size: spec.size, n: 1, negative_prompt: NEG, watermark: false },
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} ${JSON.stringify(json).slice(0, 300)}`);

  const content = json?.output?.choices?.[0]?.message?.content;
  const url = Array.isArray(content) ? content.find((c) => c.image)?.image : undefined;
  if (!url) throw new Error(`${name}: no image url in response ${JSON.stringify(json).slice(0, 300)}`);

  const img = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!img.ok) throw new Error(`${name}: download failed ${img.status}`);
  writeFileSync(out, Buffer.from(await img.arrayBuffer()));
  return out;
}

// ------------------------------------------------------------------- overlays
// Exact, text-accurate compositions (wordmark, small icons) are drawn as SVG and
// rasterized with sharp — this is where lettering must be crisp.
function emblemSvg({ size = 512, label = null }) {
  const c = size / 512;
  const spade =
    'M256 96 C256 96 168 176 168 240 C168 284 200 306 228 306 C242 306 250 300 254 296 C252 322 240 344 218 360 L294 360 C272 344 260 322 258 296 C262 300 270 306 284 306 C312 306 344 284 344 240 C344 176 256 96 256 96 Z';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="felt" cx="50%" cy="38%" r="72%">
      <stop offset="0%" stop-color="${BRAND.feltLit}"/>
      <stop offset="62%" stop-color="${BRAND.felt}"/>
      <stop offset="100%" stop-color="${BRAND.feltDeep}"/>
    </radialGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffe7ae"/>
      <stop offset="52%" stop-color="${BRAND.gold}"/>
      <stop offset="100%" stop-color="${BRAND.goldDeep}"/>
    </linearGradient>
    <filter id="soft" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="${8 * c}"/>
    </filter>
  </defs>
  <rect width="512" height="512" rx="${size > 300 ? 96 : 64}" fill="url(#felt)"/>
  <circle cx="256" cy="238" r="150" fill="${BRAND.gold}" opacity="0.13" filter="url(#soft)"/>
  <circle cx="256" cy="256" r="228" fill="none" stroke="url(#gold)" stroke-width="6" opacity="0.85"/>
  <circle cx="256" cy="256" r="212" fill="none" stroke="${BRAND.gold}" stroke-width="2" opacity="0.35" stroke-dasharray="2 10"/>
  <g transform="translate(256 244) scale(0.78) translate(-256 -256)">
    <path d="${spade}" fill="url(#gold)"/>
  </g>
  ${label ? `<text x="256" y="440" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="62" font-weight="700" letter-spacing="6" fill="${BRAND.cream}">${label}</text>` : ''}
</svg>`;
}

async function svgTo(svg, file, width) {
  const buf = await sharp(Buffer.from(svg), { density: 300 }).resize({ width }).png().toBuffer();
  writeFileSync(file, buf);
  return buf.length;
}

// ----------------------------------------------------------------- derivatives
async function derive(name, src) {
  const meta = await sharp(src).metadata();
  const written = [];

  /** Resize+crop to exact box. sharp's `.rotate()` normalises EXIF orientation. */
  const cover = async (file, w, h, position = 'centre') => {
    const buf = await sharp(src).rotate().resize({ width: w, height: h, fit: 'cover', position }).png().toBuffer();
    writeFileSync(file, buf);
    written.push(`${relative(file)} (${(buf.length / 1024).toFixed(0)}KB)`);
  };

  /** Centre-crop to a square then resize, without stretching the aspect ratio. */
  const squareCrop = async (file, w, h) => {
    const side = Math.min(meta.width ?? w, meta.height ?? h);
    const buf = await sharp(src)
      .rotate()
      .extract({ left: Math.floor(((meta.width ?? side) - side) / 2), top: Math.floor(((meta.height ?? side) - side) / 2), width: side, height: side })
      .resize({ width: w, height: h, fit: 'cover' })
      .png()
      .toBuffer();
    writeFileSync(file, buf);
    written.push(`${relative(file)} (${(buf.length / 1024).toFixed(0)}KB)`);
  };

  switch (name) {
    case 'photo':
      // @BotFather -> /setuserpic : square; Telegram renders it as small as 48px.
      await cover(join(BF, 'bot-profile-512.png'), 512, 512);
      await cover(join(BF, 'bot-profile-160.png'), 160, 160);
      await cover(join(PUB, 'apple-touch-icon.png'), 180, 180);
      break;
    case 'icon':
      await squareCrop(join(BF, 'miniapp-icon-512.png'), 512, 512);
      await squareCrop(join(PUB, 'icons', 'icon-192.png'), 192, 192);
      break;
    case 'banner':
      // Main Mini App screen image and social preview card.
      await cover(join(BF, 'miniapp-main-screen-640x320.png'), 640, 320);
      await cover(join(BF, 'miniapp-main-screen-1280x640.png'), 1280, 640);
      await cover(join(PUB, 'og-image.png'), 1200, 630);
      break;
    case 'preview':
      await cover(join(BF, 'media-preview-1080x1920.png'), 1080, 1920, 'north');
      break;
    case 'felt':
      await squareCrop(join(PUB, 'textures', 'felt-tile.png'), 512, 512);
      break;
    case 'chipset':
      await squareCrop(join(BF, 'chips-reference.png'), 768, 768);
      break;
  }
  return { size: `${meta.width}x${meta.height}`, written };
}

function relative(p) {
  return p.replace(ROOT + '/', '');
}

/**
 * Size gate. @BotFather and link-preview crawlers reject or silently downscale
 * files over ~2MB, and a 4MB PNG that Telegram recompresses loses the argument.
 * Photographic art is re-emitted as quality-tuned JPEG; anything with flat colour
 * or transparency stays PNG (palette-quantised), which is usually smaller anyway.
 */
async function fitBudget(file, maxBytes = 1_900_000) {
  let buf = readFileSync(file);
  if (buf.length <= maxBytes) return { file: relative(file), bytes: buf.length, format: 'as-is' };

  const isPng = file.endsWith('.png');
  if (isPng) {
    // Try PNG first at reduced colour depth: felt gradients and chips quantise well.
    const q = await sharp(buf).png({ palette: true, quality: 82, compressionLevel: 9 }).toBuffer();
    if (q.length <= maxBytes) {
      writeFileSync(file, q);
      return { file: relative(file), bytes: q.length, format: 'png8' };
    }
  }

  // Photographic: step down JPEG quality until it fits.
  const flat = await sharp(buf).stats();
  const photographic = flat.channels.some((c) => c.stdev > 18);
  for (const q of [88, 80, 72, 64]) {
    const out = await sharp(buf).flatten({ background: BRAND.feltDeep }).jpeg({ quality: q, mozjpeg: true, progressive: true }).toBuffer();
    if (out.length <= maxBytes) {
      const target = file.replace(/\.png$/, '.jpg');
      writeFileSync(target, out);
      if (target !== file && isPng) rmSync(file);
      return { file: relative(target), bytes: out.length, format: `jpeg${q}${photographic ? '' : ' (flat art!)'}` };
    }
  }
  return { file: relative(file), bytes: buf.length, format: 'OVER BUDGET — reduce source size' };
}

// ----------------------------------------------------------------------- main
const eq = process.argv.find((a) => a.startsWith('--only='));
const sp = process.argv[process.argv.indexOf('--only') + 1];
const ONLY = eq ? eq.split('=')[1] : (process.argv.includes('--only') && sp && !sp.startsWith('--') ? sp : '');
const only = ONLY ? ONLY.split(',') : Object.keys(SHOTS);

console.log(`wan2.7-image asset pipeline → ${MODEL}`);
console.log(`steps: ${only.join(', ')}\n`);

const manifest = {};

for (const name of only) {
  const spec = SHOTS[name];
  if (!spec) {
    console.warn(`  unknown asset "${name}", skipping`);
    continue;
  }
  try {
    const src = process.argv.includes('--no-gen') && !existsSync(join(RAW, `${name}.png`)) ? await generate(name, spec) : await generate(name, spec);
    const { size, written } = await derive(name, src);
    manifest[name] = { raw: `${relative(src)}`, generated: size, derived: written };
    console.log(`  ✓ ${name}  raw ${size}`);
    for (const w of written) console.log(`      → ${w}`);
  } catch (e) {
    console.error(`  ✘ ${name}: ${e.message}`);
    manifest[name] = { error: e.message };
  }
}

// The vector emblem is always produced: it is the deterministic fallback when a
// generation looks wrong, and it is what actually ships as the favicon.
try {
  const svg = emblemSvg({ size: 512 });
  writeFileSync(join(ROOT, 'assets', 'emblem.svg'), svg);
  await svgTo(svg, join(BF, 'emblem-512.png'), 512);
  await svgTo(svg, join(PUB, 'icons', 'icon-512.png'), 512);
  await svgTo(svg, join(PUB, 'icons', 'icon-192.png'), 192);
  await svgTo(svg, join(BF, 'miniapp-icon-100.png'), 100);
  writeFileSync(join(PUB, 'favicon.png'), await sharp(Buffer.from(svg)).resize(48, 48).png().toBuffer());
  // A wordmark lockup for the bot's about/gallery, where text must be exact.
  await svgTo(emblemSvg({ size: 640, label: 'JACKED' }), join(BF, 'wordmark-640.png'), 640);
  manifest.emblem = { derived: ['assets/botfather/emblem-512.png', 'assets/botfather/miniapp-icon-100.png', 'assets/botfather/wordmark-640.png', 'public/favicon.png', 'public/icons/*'] };
  console.log('  ✓ emblem (SVG, exact vectors) → 100/192/512/640 + favicon');
} catch (e) {
  console.error('  ✘ emblem:', e.message);
}

const budget = [];
for (const f of [
  join(BF, 'bot-profile-512.png'),
  join(BF, 'bot-profile-160.png'),
  join(BF, 'miniapp-icon-512.png'),
  join(BF, 'miniapp-icon-100.png'),
  join(BF, 'emblem-512.png'),
  join(BF, 'wordmark-640.png'),
  join(BF, 'miniapp-main-screen-640x320.png'),
  join(BF, 'miniapp-main-screen-1280x640.png'),
  join(BF, 'media-preview-1080x1920.png'),
  join(BF, 'chips-reference.png'),
  join(PUB, 'og-image.png'),
  join(PUB, 'apple-touch-icon.png'),
  join(PUB, 'textures', 'felt-tile.png'),
]) {
  if (existsSync(f)) budget.push(await fitBudget(f));
}
console.log('\nsize gate (≤1.9MB each):');
for (const b of budget) console.log(`  ${String((b.bytes / 1024).toFixed(0) + 'KB').padStart(7)}  ${b.format.padEnd(12)} ${b.file}`);

writeFileSync(join(ROOT, 'assets', 'manifest.json'), JSON.stringify({ model: MODEL, brand: BRAND, assets: manifest }, null, 2) + '\n');
console.log(`\nwrote ${relative('assets/manifest.json')}`);
console.log('Upload the files in assets/botfather/ via @BotFather (see README → "BotFather setup").');
