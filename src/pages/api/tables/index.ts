// GET /api/tables — lobby listing, straight from D1.
//
// This never touches a Durable Object. The DO publishes a throttled heartbeat into
// `tables`, so the lobby costs one indexed read no matter how many tables exist.
import { env } from 'cloudflare:workers';
import { AuthError, requireUser } from '../../../lib/auth.ts';
import { authResponse, err, ok, readJson } from '../../../lib/http.ts';
import { ensureDefaultTables, listLobbyTables } from '../../../lib/db/tablesRepo.ts';
import { listShareableTables, createPrivateTable } from '../../../lib/db/privateTables.ts';
import { validateStakes } from '../../../lib/stakes.ts';
import { miniAppLink, webAppUrl } from '../../../lib/config.ts';
import { hasAcceptedAge } from '../../../lib/db/users.ts';
import type { APIContext } from 'astro';

export const prerender = false;

export async function GET(context: APIContext): Promise<Response> {
  const { request } = context;
  let auth;
  try {
    auth = await requireUser(request, env as unknown as Env);
  } catch (e) {
    if (e instanceof AuthError) return e.toResponse();
    return authResponse(e);
  }

  await ensureDefaultTables(env.DB);
  const tables = await listLobbyTables(env.DB);

  const me = {
    userId: auth.user.telegram_user_id,
    bankrollCents: auth.user.bankroll_cents,
    ageAccepted: hasAcceptedAge(auth.user),
    needsRebuy: auth.user.bankroll_cents <= 0,
  };

  return ok({
    tables,
    // Private tables the caller is enrolled in, kept in a separate array rather than
    // a `private` flag on LobbyTable: the lobby card markup, the seat-minimum copy and
    // the "table full" logic all key off public-felt assumptions, and mixing the two
    // lists would have meant auditing every one of them for a wrong-owner case.
    privateTables: await listShareableTables(env.DB, auth.user.telegram_user_id),
    me,
    welcomeGrantCents: auth.cfg.welcomeGrantCents,
    houseWarning: auth.cfg.houseWarning,
    // Stated explicitly on the wire so the UI can be honest without hardcoding.
    money: { centsPerStar: auth.cfg.centsPerStar, cashoutAvailable: false, playMoneyOnly: true },
  });
}

// POST /api/tables — create an unlisted, invite-only table owned by the caller.
//
// Two URL shapes come back and they are not interchangeable: `webAppUrl` is the
// bare https origin+path for a `web_app` inline button, while `shareUrl` is the
// t.me/<bot>?app= form for pasting into chat text. Handing a button the second one
// is what made /balance and /start 500 in production (BUTTON_URL_INVALID), so the
// server returns both and the caller cannot pick the wrong one by accident.
export async function POST(context: APIContext): Promise<Response> {
  const { request } = context;
  let auth;
  try {
    auth = await requireUser(request, env as unknown as Env);
  } catch (e) {
    if (e instanceof AuthError) return e.toResponse();
    return authResponse(e);
  }

  if (!hasAcceptedAge(auth.user)) {
    return err('AGE_GATE_REQUIRED', 'Confirm you are 18 or over to play.', 428);
  }

  const body = await readJson<Record<string, unknown>>(request, 4_096);
  if (!body) return err('BAD_BODY', 'Expected a JSON stakes object.', 400);

  const stakes = validateStakes(body);
  if (!stakes.ok) return err(stakes.code, stakes.message, 400);

  let created;
  try {
    created = await createPrivateTable(env.DB, auth.user.telegram_user_id, stakes.value);
  } catch (e) {
    const msg = (e as Error).message ?? '';
    if (msg.startsWith('RATE_LIMITED')) return err('TOO_MANY_TABLES', msg.slice(msg.indexOf(':') + 2), 429);
    throw e;
  }

  const path = `/table/${created.tableId}`;
  return ok({
    tableId: created.tableId,
    stakes: stakes.value,
    warnings: stakes.warnings,
    webAppUrl: webAppUrl(auth.cfg, path),
    shareUrl: miniAppLink(auth.cfg, path),
    // Inline mode cannot see a table until it exists, so the UI explains this step
    // rather than leaving the owner to discover it after the fact.
    inlineHint: 'Type @JackedBot in a group chat and pick this table to post a Join button.',
  });
}
