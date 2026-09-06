// =============================================================================
// Resolve a Telegram start param into a route, on the client.
//
// Telegram appends `tgWebAppStartParam` to the opened app URL - as a query
// parameter, and on some clients inside the hash - and also exposes it as
// `initDataUnsafe.start_param`. All three are read, in that order, because which
// one is populated varies by client and by how the app was launched.
//
// This runs where the Main Screen URL lands, which is `/`. Without it a deep link
// opens the lobby and silently drops the invite.
// =============================================================================

import { pathForStartParam } from '../../shared/deeplink.ts';

function fromHash(): string | null {
  // Clients differ on whether the param sits in the query or in a hash query.
  const hash = location.hash.replace(/^#/, '');
  const q = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : hash;
  if (!q.includes('=')) return null;
  return new URLSearchParams(q).get('tgWebAppStartParam');
}

/** The raw start param Telegram supplied for this launch, if any. */
export function telegramStartParam(): string | null {
  const fromQuery = new URLSearchParams(location.search).get('tgWebAppStartParam');
  if (fromQuery) return fromQuery;
  const hashed = fromHash();
  if (hashed) return hashed;
  const app = (window as unknown as { Telegram?: { WebApp?: { initDataUnsafe?: { start_param?: string } } } }).Telegram?.WebApp;
  return app?.initDataUnsafe?.start_param ?? null;
}

/**
 * Navigate to the route this launch asked for. Returns true when a navigation was
 * started. `h` (the plain home link) resolves to `/`, which is where we already
 * are, so it is a no-op by design rather than a redirect loop.
 */
export function followTelegramStartParam(): boolean {
  const target = pathForStartParam(telegramStartParam());
  if (!target) return false;
  const here = `${location.pathname}${location.search}`;
  const wanted = new URL(target, location.origin);
  if (here === `${wanted.pathname}${wanted.search}`) return false;
  location.replace(wanted.pathname + wanted.search);
  return true;
}
