// =============================================================================
// Mini App deep links.
//
// Telegram has ONE link form that opens a Mini App at a specific place:
//
//     https://t.me/<bot>?startapp=<param>
//
// The `<param>` is not a URL. It is an opaque string, max 64 base64url
// characters, that Telegram hands to the opened app as `tgWebAppStartParam` (and
// as `initDataUnsafe.start_param`). The app is responsible for turning it back
// into a route.
//
// There is no `?app=<url>` form. `https://t.me/JackedBot?app=https://...` is
// something I invented; Telegram parses the t.me link, finds an unknown
// parameter, ignores it, and opens the bot's chat. That is the whole of
// "the invite link just opens the bot", and it was true of every link this app
// ever generated.
//
// A 32-hex table id fits the budget comfortably (`t_` + 32 = 34 chars) and is
// already base64url-safe, so the invite capability travels intact without
// encoding a URL through a character set that would reject `:` and `/`.
// =============================================================================

/** Only hex ids are accepted, so a start param can never smuggle an arbitrary path. */
const TABLE_ID = /^[0-9a-f]{32}$/;

/** `/table/<id>` with an optional query, as built by the lobby, the API and inline. */
const TABLE_PATH = /^\/table\/([0-9a-f]{32})(?:\?.*)?$/;

/** Encode an in-app path into a Telegram start param, or null if there is no scheme for it. */
export function startParamForPath(path: string): string | null {
  const match = TABLE_PATH.exec(path);
  if (match) return `t_${match[1]}`;
  if (path === '/' || path === '' || path === '/index.html') return 'h';
  return null;
}

/**
 * Decode a start param back into the path to open.
 *
 * Table invites carry `?invite=1` on the way in: opening a private table from an
 * invite is what redeems membership, and a link that lands the recipient outside
 * the invite path gets them refused with NOT_A_MEMBER.
 */
export function pathForStartParam(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  if (raw === 'h') return '/';
  if (!raw.startsWith('t_')) return null;
  const id = raw.slice(2);
  return TABLE_ID.test(id) ? `/table/${id}?invite=1` : null;
}
