// Chip tray: local chip stack, sent to the server as an absolute wager.
// Chips are visual denominations from the server's own config, so a table can
// change its ladder without a client deploy.
import { useMemo } from 'preact/hooks';
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

const CHIP_LABEL: Record<number, string> = {
  100: '$1',
  500: '$5',
  1000: '$10',
  5000: '$50',
  10000: '$100',
  50000: '$500',
};

export function ChipTray({ chips, stack, minBetCents, maxBetCents, availableCents, disabled, onChange, onSend }: ChipTrayProps) {
  const total = useMemo(() => stack.reduce((a, b) => a + b, 0), [stack]);
  const counts = useMemo(() => {
    const m = new Map<number, number>();
    for (const c of stack) m.set(c, (m.get(c) ?? 0) + 1);
    return m;
  }, [stack]);

  const add = (value: number) => {
    if (disabled) return;
    const next = total + value;
    if (next > maxBetCents) {
      haptic('warning');
      return;
    }
    if (next > availableCents) {
      haptic('error');
      return;
    }
    haptic('select');
    onChange([...stack, value]);
  };

  const undo = () => {
    if (!stack.length) return;
    haptic('light');
    onChange(stack.slice(0, -1));
  };

  const clear = () => {
    if (!stack.length) return;
    haptic('light');
    onChange([]);
    onSend([]);
  };

  return (
    <div class="tray">
      <div class="tray__chips">
        {chips.map((value) => {
          const tooRich = value > availableCents - total + value && total + value > availableCents;
          return (
            <button
              key={value}
              type="button"
              class={`chip chip--${value}${counts.get(value) ? ' chip--used' : ''}`}
              onClick={() => add(value)}
              disabled={disabled || total + value > maxBetCents || total + value > availableCents}
              aria-label={`Add ${CHIP_LABEL[value] ?? formatCents(value)} chip`}
              title={CHIP_LABEL[value] ?? formatCents(value)}
            >
              <span>{CHIP_LABEL[value] ?? formatCents(value)}</span>
              {counts.get(value) ? <em class="chip__count">{counts.get(value)}</em> : null}
              {tooRich ? null : null}
            </button>
          );
        })}
      </div>

      <div class="tray__meta">
        <span class="tray__stack" aria-live="polite">
          {total ? formatCents(total) : 'no wager'}
        </span>
        <span class="tray__limits">
          min {formatCents(minBetCents)} · max {formatCents(maxBetCents)}
        </span>
        <div class="tray__buttons">
          <button type="button" class="btn btn--ghost btn--sm" onClick={undo} disabled={disabled || !stack.length}>
            Undo
          </button>
          <button type="button" class="btn btn--ghost btn--sm" onClick={clear} disabled={disabled || !stack.length}>
            Clear
          </button>
          <button
            type="button"
            class="btn btn--primary btn--sm"
            onClick={() => onSend(stack)}
            disabled={disabled || total === 0 || total > availableCents}
          >
            Bet {total ? formatCents(total) : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
