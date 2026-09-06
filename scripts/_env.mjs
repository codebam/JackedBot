// Shared loader for the operator scripts: reads secrets/vars from the process
// environment first, then `.dev.vars` (local dev), then `.dev.vars.example` is
// intentionally NOT read so a placeholder can never be deployed by accident.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadDevVars(file = join(ROOT, '.dev.vars')) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

const FILE_VARS = loadDevVars();

/** Minimal `[vars]` reader for wrangler.toml — enough for flat string keys. */
function wranglerVars() {
  const out = {};
  for (const file of ['wrangler.toml', 'wrangler.jsonc', 'wrangler.json']) {
    const p = join(ROOT, file);
    if (!existsSync(p)) continue;
    if (file.endsWith('.toml')) {
      let inVars = false;
      for (const raw of readFileSync(p, 'utf8').split('\n')) {
        const line = raw.trim();
        if (line.startsWith('[')) {
          inVars = line === '[vars]';
          continue;
        }
        if (!inVars || !line.includes('=')) continue;
        const eq = line.indexOf('=');
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
        if (value) out[key] = value;
      }
    } else {
      try {
        const j = JSON.parse(readFileSync(p, 'utf8').replace(/^\s*\/\/.*$/gm, ''));
        for (const [k, v] of Object.entries(j.vars ?? {})) if (typeof v === 'string' && v) out[k] = v;
      } catch {
        /* jsonc with comments: fall through, --origin still works */
      }
    }
  }
  return out;
}

const TOML_VARS = wranglerVars();

export function getVar(name) {
  // Priority: real environment > .dev.vars (local secrets/vars) > wrangler [vars].
  const v = process.env[name] ?? FILE_VARS[name] ?? TOML_VARS[name] ?? '';
  return String(v).trim();
}

/** `--flag=value` or `--flag value`; returns null when absent. */
export function flag(name, argv = process.argv.slice(2)) {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(`--${name}=`.length);
  const i = argv.indexOf(`--${name}`);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  if (i !== -1) return '';
  return null;
}

export function hasFlag(name, argv = process.argv.slice(2)) {
  return argv.includes(`--${name}`);
}

export function requireVar(name, hint) {
  const v = getVar(name);
  if (!v) {
    console.error(`\nMissing ${name}.`);
    if (hint) console.error(hint);
    console.error(`Set it in your shell, or in .dev.vars for local development.\n`);
    process.exit(2);
  }
  return v;
}

export const API = 'https://api.telegram.org';

export async function tgCall(token, method, payload = {}) {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => null);
  if (!json?.ok) {
    throw new Error(`${method} failed (${res.status}): ${json?.description ?? 'unparseable response'}`);
  }
  return json.result;
}

/** Validate `https://host` with no path, and return it without a trailing slash. */
export function normalizeOrigin(raw) {
  if (!raw) return null;
  const withScheme = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
  const u = new URL(withScheme);
  if (!/^https?:$/.test(u.protocol)) throw new Error(`unsupported protocol: ${u.protocol}`);
  if (u.pathname !== '/' && u.pathname !== '') {
    console.warn(`(ignoring the path "${u.pathname}" — pass only the origin)`);
  }
  return `${u.protocol}//${u.host}`;
}

/**
 * Where the Worker is actually reachable, in priority order:
 *   --origin flag > PUBLIC_ORIGIN var > wrangler.jsonc/toml vars > inferred
 * workers.dev URL derived from `--subdomain`/the account.
 */
export function resolveOrigin() {
  const explicit = normalizeOrigin(flag('origin') ?? getVar('PUBLIC_ORIGIN') ?? getVar('ORIGIN') ?? '');
  if (explicit) return explicit;
  const sub = getVar('WORKERS_SUBDOMAIN') || flag('subdomain');
  if (sub) return normalizeOrigin(`https://jackedbot.${sub}.workers.dev`);
  return null;
}
