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
//
// But the param describes the WEBVIEW LAUNCH, not the page currently loading.
// Telegram keeps the Mini App alive and navigates it in place, and it keeps
// re-delivering the original `start_param` on every page that asks. So a
// SessionGate on any later page (/new-table, the lobby after leaving a table)
// that trusts that stale value yanks the player back to wherever the launch
// pointed: the screen flashes and the link "does nothing" - which is exactly how
// this behaved for Create-a-private-table after the startapp change. Fix: each
// param value is honoured at most once per session. A genuine re-launch is still
// followed, because Telegram delivers its param in the URL of the load it starts,
// and the URL is never stale.
// =============================================================================

import { pathForStartParam } from '../../shared/deeplink.ts';

/** sessionStorage key holding the last start param whose routing has been spent. */
const FOLLOWED_KEY = 'jackedbot.followedStartParam';

function fromQuery(): string | null {
  return new URLSearchParams(location.search).get('tgWebAppStartParam');
}

function fromHash(): string | null {
  // Clients differ on whether the param sits in the query or in a hash query.
  const hash = location.hash.replace(/^#/, '');
  const q = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : hash;
  if (!q.includes('=')) return null;
  return new URLSearchParams(q).get('tgWebAppStartParam');
}

/** The param Telegram delivered to THIS page load's URL, if any. Never stale. */
function startParamInUrl(): string | null {
  return fromQuery() ?? fromHash();
}

/** The raw start param Telegram supplied for this launch, if any. */
export function telegramStartParam(): string | null {
  const fromUrl = startParamInUrl();
  if (fromUrl) return fromUrl;
  const app = (window as unknown as { Telegram?: { WebApp?: { initDataUnsafe?: { start_param?: string } } } }).Telegram?.WebApp;
  return app?.initDataUnsafe?.start_param ?? null;
}

/**
 * Navigate to the route this launch asked for. Returns true when a navigation was
 * started. `h` (the plain home link) resolves to `/`, which is where the main
 * screen already is, so it is a no-op by design rather than a redirect loop.
 */
export function followTelegramStartParam(): boolean {
  const raw = telegramStartParam();
  if (!raw) return false;
  const target = pathForStartParam(raw);
  if (!target) return false;

  // URL delivery means Telegram started this load for that link: honour it even
  // if the same value was spent earlier, because re-tapping a link is a request
  // to go there again. initDataUnsafe alone means we are mid-session looking at
  // the value the original launch left behind: spend it once, ever.
  const fresh = startParamInUrl() === raw;

  let remembered: string | null | undefined;
  try {
    remembered = sessionStorage.getItem(FOLLOWED_KEY);
  } catch {
    remembered = undefined;
  }
  if (remembered === undefined) {
    // No storage to mark the param spent with (private mode). Re-following a
    // stale value on every page is precisely the bug; follow only the URL.
    if (!fresh) return false;
  } else if (!fresh && remembered === raw) {
    return false;
  }
  try {
    sessionStorage.setItem(FOLLOWED_KEY, raw);
  } catch {
    // Losing the once-only guarantee is not worth refusing the navigation over.
  }

  const wanted = new URL(target, location.origin);
  // A start param riding in the URL is launch noise, not a place to be: `/` with
  // `?tgWebAppStartParam=h` IS the home route, and replacing it would reload the
  // page just to strip a query parameter. A target's own query (e.g. `?invite=1`)
  // still has to match.
  const sameQuery = !wanted.search || wanted.search === location.search;
  if (location.pathname === wanted.pathname && sameQuery) return false;
  location.replace(wanted.pathname + wanted.search);
  return true;
}
