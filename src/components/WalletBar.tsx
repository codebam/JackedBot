// =============================================================================
// WalletBar — balance, buy-in, and the one UI detail that matters most when real
// money is adjacent: after `openInvoice` reports "paid", we do NOT add chips.
// The webhook is the only thing that can credit a bankroll, so we poll until the
// server's number moves. Optimistic balance updates here would show chips that may
// not exist yet.
// =============================================================================
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { api, ApiError, humanError } from '../lib/client/api.ts';
import { haptic, openInvoice, showNotice, isInTelegram } from '../lib/client/telegram.ts';
import { formatCents } from '../shared/money.ts';

export interface WalletBarProps {
  initialBankrollCents: number;
  starsPerPurchase?: number;
  centsPerStar?: number;
  /** Rebuy prompt appears whenever the balance bottoms out. */
  onBankroll?: (cents: number) => void;
  compact?: boolean;
}

interface Session {
  bankrollCents: number;
  welcomeGranted?: boolean;
  needsRebuy?: boolean;
}

const POLL_MS = 1_200;
const POLL_TIMEOUT_MS = 25_000;

export function WalletBar({ initialBankrollCents, starsPerPurchase = 1, centsPerStar = 1000, onBankroll, compact = false }: WalletBarProps) {
  const [bankroll, setBankroll] = useState(initialBankrollCents);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const mounted = useRef(true);
  const expectedRef = useRef<number>(initialBankrollCents);

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
    const before = bankroll;
    expectedRef.current = before + stars * centsPerStar;
    try {
      const inv = await api<{ link: string; stars: number; cents: number; centsLabel: string }>('/api/buyin', {
        method: 'POST',
        body: { stars },
      });
      const status = await openInvoice(inv.link);
      if (status === 'paid') {
        setNote(`Payment confirmed — waiting for your chips…`);
        const credited = await waitForCredit(before);
        if (credited === null) {
          setNote(`Payment received. Your chips usually land within a minute — pull to refresh.`);
        }
      } else if (status === 'cancelled' || status === 'back') {
        setNote('Purchase cancelled. Nothing was charged.');
        expectedRef.current = before;
      } else {
        setNote(`Payment ${status}. If Stars left your account, support can trace it by charge id.`);
        expectedRef.current = before;
      }
    } catch (e) {
      setNote(e instanceof ApiError && e.code === 'AGE_GATE_REQUIRED' ? 'Confirm you are 18+ before buying chips.' : humanError(e));
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
    if (initialBankrollCents !== undefined) setBankroll(initialBankrollCents);
  }, [initialBankrollCents]);

  return (
    <div class={compact ? 'wallet wallet--compact' : 'wallet'}>
      <div class="wallet__balance">
        <span class="wallet__label">Bankroll</span>
        <strong class="wallet__amount" aria-live="polite">
          {formatCents(bankroll)}
        </strong>
        <span class="wallet__tag">play money</span>
      </div>

      <div class="wallet__actions">
        <button class="btn btn--gold btn--sm" type="button" onClick={() => buy(starsPerPurchase)} disabled={busy}>
          {busy ? 'Working…' : `1 ⭐ → ${formatCents(centsPerStar)}`}
        </button>
        {bankroll <= 0 ? (
          <button class="btn btn--ghost btn--sm" type="button" onClick={() => buy(5)} disabled={busy}>
            5 ⭐ → {formatCents(5 * centsPerStar)}
          </button>
        ) : null}
      </div>

      {note ? (
        <p class="wallet__note" role="status">
          {note}
        </p>
      ) : null}
      {bankroll <= 0 ? (
        <p class="wallet__rebuy">
          You are out of chips. Stacks from several purchases add together — {formatCents(centsPerStar)} per Star.
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

void showNotice;
