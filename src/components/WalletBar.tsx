// =============================================================================
// WalletBar — balance, buy-in, and the one UI detail that matters most when real
// money is adjacent: after `openInvoice` reports "paid", we do NOT add chips.
// The webhook is the only thing that can credit a bankroll, so we poll until the
// server's number moves. Optimistic balance updates here would show chips that may
// not exist yet.
// =============================================================================
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { api, ApiError, humanError } from '../lib/client/api.ts';
import { haptic, openInvoice, isInTelegram } from '../lib/client/telegram.ts';
import { formatCents } from '../shared/money.ts';

export interface WalletBarProps {
  /**
   * SSR's balance, when SSR could see initData. Usually it cannot - Telegram hands
   * initData to the WebApp client object, not the URL - so this is a fast path, not
   * a requirement. When absent the bar fetches its own balance, because the lobby
   * used to render this component only if SSR resolved an identity, which left real
   * players with no bankroll, no buy button, and a "How the money works" section
   * pointing at a button that was not there.
   */
  initialBankrollCents?: number | null;
  starsPerPurchase?: number;
  centsPerStar?: number;
  /** Server's own one-line description of what a purchase delivers. */
  purchaseNote?: string;
  /** Rebuy prompt appears whenever the balance bottoms out. */
  onBankroll?: (cents: number) => void;
  compact?: boolean;
}

interface Session {
  bankrollCents: number;
  needsRebuy?: boolean;
  /** Server-formatted labels for the free credits, so the client never derives them. */
  welcomeGranted?: boolean;
  welcomeLabel?: string;
  reliefGranted?: boolean;
  reliefLabel?: string;
}

/** POST /api/buyin's reply. `disclaimer` and `payload` are both meant to be shown. */
interface Invoice {
  link: string;
  stars: number;
  cents: number;
  centsLabel: string;
  payload: string;
  disclaimer: string;
}

const POLL_MS = 1_200;
const POLL_TIMEOUT_MS = 25_000;

export function WalletBar({
  initialBankrollCents,
  starsPerPurchase = 1,
  centsPerStar = 1000,
  purchaseNote,
  onBankroll,
  compact = false,
}: WalletBarProps) {
  // null = not known yet. Distinct from 0 on purpose: rendering $0.00 before the
  // fetch lands would be a false balance AND would fire the out-of-chips copy at a
  // player who has chips.
  const [bankroll, setBankroll] = useState<number | null>(initialBankrollCents ?? null);
  const [grant, setGrant] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const apply = useCallback(
    (cents: number) => {
      if (!mounted.current) return;
      setBankroll(cents);
      onBankroll?.(cents);
    },
    [onBankroll],
  );

  // Bootstrap on mount when SSR could not supply a balance. POST (not GET) because
  // its reply carries the welcome/relief labels, and de5dfb8's whole point was that
  // a balance moving to $10 with no explanation reads as a bug or an unauthorised
  // grant. bootstrapUser is idempotent, so this is safe to race with SessionGate's
  // own call.
  useEffect(() => {
    if (initialBankrollCents !== null && initialBankrollCents !== undefined) return;
    let alive = true;
    void (async () => {
      try {
        const s = await api<Session>('/api/session', { method: 'POST', body: {} });
        if (!alive) return;
        apply(s.bankrollCents);
        if (s.welcomeGranted && s.welcomeLabel) {
          setGrant(`A free ${s.welcomeLabel} starter stack was added to your wallet. No purchase was made.`);
        } else if (s.reliefGranted && s.reliefLabel) {
          setGrant(`You were out of chips, so the house added ${s.reliefLabel} of play money to keep you at the table.`);
        }
      } catch {
        // No session, or a plain browser. Leave the balance unknown rather than
        // showing $0.00; SessionGate owns explaining the session state.
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = await api<Session>('/api/session', { method: 'GET' });
      apply(s.bankrollCents);
      return s;
    } catch {
      return null;
    }
  }, [apply]);

  async function buy(stars: number) {
    if (busy) return;
    if (!isInTelegram()) {
      setNote('Payments need the Telegram app. Open this page inside Telegram to buy chips.');
      return;
    }
    setBusy(true);
    setNote(null);
    haptic('light');
    // Establish the baseline the credit is measured against. If the balance was
    // still unknown, read it first: guessing 0 would let waitForCredit report the
    // player's entire stack as the amount this purchase added.
    const before = bankroll ?? (await refresh())?.bankrollCents ?? 0;
    let inv: Invoice;
    try {
      inv = await api<Invoice>('/api/buyin', { method: 'POST', body: { stars } });
    } catch (e) {
      setNote(e instanceof ApiError && e.code === 'AGE_GATE_REQUIRED' ? 'Confirm you are 18+ before buying chips.' : humanError(e));
      haptic('error');
      if (mounted.current) setBusy(false);
      return;
    }

    try {
      const status = await openInvoice(inv.link);
      if (status === 'paid') {
        setNote(`Payment confirmed — waiting for your ${inv.centsLabel} of chips…`);
        const credited = await waitForCredit(before);
        if (credited === null) {
          setNote(
            `Payment received, but your chips have not landed yet. They usually appear within a minute — pull to refresh. Reference ${inv.payload}.`,
          );
        }
      } else if (status === 'cancelled' || status === 'back') {
        setNote('Purchase cancelled. Nothing was charged.');
      } else {
        // "Contact support" with no reference and no way to reach anyone was a dead
        // end. The payload is what the ledger keys the payment on, so quoting it is
        // what actually makes the charge traceable.
        setNote(
          `Payment ended as "${status}" and your chips were not added. If Stars left your account, message @JackedBot quoting ${inv.payload}.`,
        );
      }
    } catch (e) {
      setNote(humanError(e));
      haptic('error');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  /** Poll the server until the balance reflects the purchase. Returns null on timeout. */
  async function waitForCredit(before: number): Promise<number | null> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const s = await refresh();
      if (s && s.bankrollCents > before) {
        haptic('success');
        setNote(`+${formatCents(s.bankrollCents - before)} in play money added.`);
        return s.bankrollCents;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    return null;
  }

  useEffect(() => {
    if (initialBankrollCents !== undefined && initialBankrollCents !== null) setBankroll(initialBankrollCents);
  }, [initialBankrollCents]);

  const broke = bankroll !== null && bankroll <= 0;

  return (
    <div class={compact ? 'wallet wallet--compact' : 'wallet'}>
      <div class="wallet__balance">
        <span class="wallet__label">Bankroll</span>
        <strong class="wallet__amount" aria-live="polite">
          {/* An em dash, not $0.00: the balance is not known yet, and a number here
              would be invented. Reserves the same width so nothing shifts. */}
          {bankroll === null ? '—' : formatCents(bankroll)}
        </strong>
        <span class="wallet__tag">play money</span>
      </div>

      <div class="wallet__actions">
        <button class="btn btn--gold btn--sm" type="button" onClick={() => buy(starsPerPurchase)} disabled={busy}>
          {busy ? 'Working…' : `${starsPerPurchase} ⭐ → ${formatCents(starsPerPurchase * centsPerStar)}`}
        </button>
        {broke ? (
          <button class="btn btn--ghost btn--sm" type="button" onClick={() => buy(5)} disabled={busy}>
            5 ⭐ → {formatCents(5 * centsPerStar)}
          </button>
        ) : null}
      </div>

      {/* What a purchase delivers, stated before any payment sheet opens rather than
          only inside it. This is the server's own wording (cfg.buyIn.description),
          so the client is not authoring its own description of a real charge. */}
      {purchaseNote ? <p class="wallet__terms">{purchaseNote}</p> : null}

      {grant ? (
        <p class="wallet__grant" role="status">
          🎁 {grant} It cannot be cashed out.
        </p>
      ) : null}

      {note ? (
        <p class="wallet__note" role="status">
          {note}
        </p>
      ) : null}

      {broke ? (
        <p class="wallet__rebuy" role="status">
          <b>You are out of chips.</b> That is the whole cost of a bad run — chips are play money, so no Stars, no cash and
          nothing else was lost, and there is no debt. Buy a stack above to keep playing; stacks from separate purchases add
          together.
        </p>
      ) : null}
    </div>
  );
}

/** Small standalone balance chip for the table header, driven by the socket. */
export function BalancePill({ cents, needsRebuy }: { cents: number; needsRebuy?: boolean }) {
  return (
    <span class={needsRebuy ? 'pill pill--warn' : 'pill'}>
      {formatCents(cents)}
      {needsRebuy ? ' · out of chips' : ''}
    </span>
  );
}
