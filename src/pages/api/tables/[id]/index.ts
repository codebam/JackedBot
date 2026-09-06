// GET /api/tables/[id] — one table's public lobby card.
import { env } from 'cloudflare:workers';
import { AuthError, requireUser } from '../../../../lib/auth.ts';
import { authResponse, err, ok, parseTableId } from '../../../../lib/http.ts';
import { getTableConfig } from '../../../../lib/db/tablesRepo.ts';
import { RULES } from '../../../../game/rules.ts';
import { formatCents } from '../../../../shared/money.ts';
import type { APIContext } from 'astro';

export const prerender = false;

export async function GET(context: APIContext<{ id: string }>): Promise<Response> {
  const { request, params } = context;
  let auth;
  try {
    auth = await requireUser(request, env as unknown as Env);
  } catch (e) {
    if (e instanceof AuthError) return e.toResponse();
    return authResponse(e);
  }

  const id = parseTableId(params.id);
  if (!id) return err('BAD_TABLE_ID', 'Unknown table.', 400);

  const cfg = await getTableConfig(env.DB, id);
  if (!cfg) return err('TABLE_NOT_FOUND', 'That table does not exist.', 404);

  return ok({
    ...cfg,
    chips: [...RULES.chipDenominations].filter((c) => c <= cfg.maxBetCents),
    minBetLabel: formatCents(cfg.minBetCents),
    maxBetLabel: formatCents(cfg.maxBetCents),
    seatFloorLabel: cfg.minBankrollCents ? formatCents(cfg.minBankrollCents) : null,
    meBankrollCents: auth.user.bankroll_cents,
    canSit: auth.user.bankroll_cents >= Math.max(cfg.minBankrollCents, 1),
  });
}
