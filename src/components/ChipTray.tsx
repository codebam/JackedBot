// Chip tray: local chip stack, sent to the server as an absolute wager.
// Chips are visual denominations from the server's own config, so a table can
// change its ladder without a client deploy.
//
// The stack here is a *draft*: chips accumulate locally and only "Bet" commits,
// because the server rejects a sub-minimum wager outright (`WAGER_TOO_LOW`) and
// would bounce every single $1 tap. All the limits below come from the server's
// own config and balance — nothing here decides whether a bet is accepted.
import { useMemo, useState } from 'preact/hooks';
import { formatCents } from '../shared/money.ts';
import { haptic } from '../lib/client/telegram.ts';

export interface ChipTrayProps {
  chips: number[];
  stack: number[];
  minBetCents: number;
  maxBetCents: number;
  availableCents: number;
  disabled?: boolean;
  onChange: (stack: number[]) => void;
  onSend: (stack: number[]) => void;
}

/** The server refuses a wager of more than 40 chips; do not build one it will bounce. */
const MAX_CHIPS_PER_WAGER = 40;

const CHIP_LABEL: Record<number, string> = {
  100: '$1',
  500: '$5',
  1000: '$10',
  5000: '$50',
  10000: '$100',
  50000: '$500',
};

/**
 * The largest wager the server's own limits allow, built from the table's chip
 * ladder. Pure arithmetic on published numbers — the server still decides whether
 * to accept it, and "Bet" stays disabled until it clears the table minimum.
 */
export function maxStack(chips: readonly number[], capCents: number): number[] {
  const out: number[] = [];
  let running = 0;
  for (const value of [...chips].sort((a, b) => b - a)) {
    while (running + value <= capCents && out.length < MAX_CHIPS_PER_WAGER) {
      out.push(value);
      running += value;
    }
  }
  return out;
}

export function ChipTray({ chips, stack, minBetCents, maxBetCents, availableCents, disabled, onChange, onSend }: ChipTrayProps) {
  const total = useMemo(() => stack.reduce((a, b) => a + b, 0), [stack]);
  const counts = useMemo(() => {
    const m = new Map<number, number>();
    for (const c of stack) m.set(c, (m.get(c) ?? 0) + 1);
    return m;
  }, [stack]);
  // A refused tap has to say why on-screen: a haptic buzz is the whole story for a
  // player who has vibration off, and it never explains *which* limit they hit.
  const [note, setNote] = useState<string | null>(null);

  const label = (value: number) => CHIP_LABEL[value] ?? formatCents(value);
  const belowMin = total > 0 && total < minBetCents;

  const add = (value: number) => {
    if (disabled) return;
    const next = total + value;
    if (next > maxBetCents) {
      haptic('warning');
      setNote(`${label(value)} would pass the ${formatCents(maxBetCents)} table maximum.`);
      return;
    }
    if (next > availableCents) {
      haptic('error');
      setNote(`Not enough chips — you have ${formatCents(availableCents)} available at this table.`);
      return;
    }
    haptic('select');
    setNote(null);
    onChange([...stack, value]);
  };

  const undo = () => {
    if (!stack.length) return;
    haptic('light');
    setNote(null);
    onChange(stack.slice(0, -1));
  };

  const clear = () => {
    if (!stack.length) return;
    haptic('light');
    setNote(null);
    onChange([]);
    onSend([]);
  };

  /** Fill to the largest wager the server's own limits and balance allow. */
  const fillMax = () => {
    if (disabled) return;
    const next = maxStack(chips, Math.min(maxBetCents, availableCents));
    if (!next.length) {
      haptic('error');
      setNote(`The smallest chip is ${label(Math.min(...chips))} — you have ${formatCents(availableCents)} available.`);
      return;
    }
    haptic('select');
    setNote(null);
    onChange(next);
  };

  return (
    <div class="tray">
      <div class="tray__chips">
        {chips.map((value) => (
          <button
            key={value}
            type="button"
            class={`chip chip--${value}${counts.get(value) ? ' chip--used' : ''}`}
            onClick={() => add(value)}
            disabled={disabled || total + value > maxBetCents || total + value > availableCents}
            aria-label={`Add ${label(value)} chip`}
          >
            <span aria-hidden="true">{label(value)}</span>
            {counts.get(value) ? <em class="chip__count">{counts.get(value)}</em> : null}
          </button>
        ))}
      </div>

      <div class="tray__meta">
        <span class="tray__stack" aria-live="polite">
          {total ? formatCents(total) : 'no wager'}
        </span>
        <span class="tray__limits">
          min {formatCents(minBetCents)} · max {formatCents(maxBetCents)}
        </span>
        <div class="tray__buttons">
          <button type="button" class="btn btn--ghost btn--sm tray__btn" onClick={undo} disabled={disabled || !stack.length}>
            Undo
          </button>
          <button type="button" class="btn btn--ghost btn--sm tray__btn" onClick={clear} disabled={disabled || !stack.length}>
            Clear
          </button>
          <button type="button" class="btn btn--ghost btn--sm tray__btn" onClick={fillMax} disabled={disabled}>
            Max
          </button>
          <button
            type="button"
            class="btn btn--primary btn--sm tray__btn"
            onClick={() => {
              setNote(null);
              onSend(stack);
            }}
            disabled={disabled || belowMin || total === 0 || total > maxBetCents || total > availableCents}
          >
            Bet{total ? ` ${formatCents(total)}` : ''}
          </button>
        </div>
      </div>

      {/* One line that is either the reason the bet is blocked or the reason the
          last tap was refused. role=status keeps it polite for screen readers. */}
      <p class="tray__note" role="status">
        {note ?? (belowMin ? `Minimum wager here is ${formatCents(minBetCents)}.` : '')}
      </p>
    </div>
  );
}
