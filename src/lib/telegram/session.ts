// =============================================================================
// Account bootstrap, shared by the bot's /start handler and the mini-app session
// endpoint so both entry paths produce an identical account state.
//
// Ordering matters for compliance: the free stack is minted at account creation,
// but *sitting at a table* additionally requires the 18+ attestation (enforced in
// the Table DO's `cmdSit`). A minor can therefore hold chips and never gamble them.
// =============================================================================
import { ensureUser, hasAcceptedAge, type UserRow } from '../db/users.ts';
import { ensureWelcomeGrant } from '../db/welcome.ts';
import { fromTgUser } from '../db/users.ts';
import type { TelegramWebAppUser } from './initData.ts';
import type { AppConfig } from '../config.ts';

export interface BootstrapResult {
  user: UserRow;
  /** Balance after the bootstrap, which may differ from `user` when we just minted. */
  bankrollCents: number;
  welcomeGranted: boolean;
  welcomeCents: number;
  ageAccepted: boolean;
}

/**
 * create-or-touch the user, then make sure the one-time free stack exists.
 * `ensureWelcomeGrant` is idempotent (UNIQUE ledger key), so calling this on
 * every mini-app launch costs one indexed read.
 */
export async function bootstrapUser(env: Env, cfg: AppConfig, tgUser: TelegramWebAppUser): Promise<BootstrapResult> {
  const user = await ensureUser(env.DB, fromTgUser(tgUser));

  const grantCents = cfg.welcomeGrantCents;
  const grant = await ensureWelcomeGrant(env.DB, user.telegram_user_id, grantCents);

  // `applyLedgerOp` already reports the post-write balance; prefer it, and only
  // re-read when we skipped the write so `user` cannot be stale.
  const bankrollCents = grant.granted ? grant.bankrollCents : user.bankroll_cents;

  return {
    user,
    bankrollCents,
    welcomeGranted: grant.granted,
    welcomeCents: grant.granted ? grantCents : 0,
    ageAccepted: hasAcceptedAge(user),
  };
}

export const AGE_GATE_STATEMENT = 'I am 18 or older and understand these chips are play money with no cash value.';
