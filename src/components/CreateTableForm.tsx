// CreateTableForm — the "full control" stakes form for a private table.
//
// Why this is a Mini App form and not a chat conversation: six fields with
// relationships between them (max >= min, buy-in >= min bet, seats 1-5) cannot be
// typed reliably into a message, and the validation lives in one place
// (`validateStakes`, shared with POST /api/tables) so the form cannot accept what
// the server would reject. Dollar inputs are converted to integer cents here and
// the server still has the final say.
import { useState } from 'preact/hooks';
import { api } from '../lib/client/api.ts';
import { formatCents } from '../shared/money.ts';

interface Created {
  tableId: string;
  stakes: { name: string; minBetCents: number; maxBetCents: number; buyInCents: number; minBankrollCents: number; seatCount: number };
  warnings: string[];
  webAppUrl: string;
  shareUrl: string;
  inlineHint: string;
}

interface Preset {
  label: string;
  min: number; // dollars
  max: number;
  buyIn: number;
  floor: number;
  seats: number;
}

const PRESETS: Preset[] = [
  { label: 'Friendly · $1–$50', min: 1, max: 50, buyIn: 20, floor: 0, seats: 5 },
  { label: 'Standard · $5–$200', min: 5, max: 200, buyIn: 100, floor: 25, seats: 5 },
  { label: 'High · $25–$500', min: 25, max: 500, buyIn: 500, floor: 250, seats: 4 },
];

/**
 * Dollars in the DOM, integer cents on the wire. Empty is null, not 0.
 *
 * Named `toCents`, not `cents`. validateStakes exports its own `cents`, which means
 * "this must ALREADY be an integer count of cents" - the opposite job. With both
 * called `cents`, this file's seats field went out as `cents('5')` = 500 and the
 * server correctly answered "A table seats between 1 and 5 players." A seat count is
 * a count of people; it was never money, and no comment about "integer-cents
 * discipline" makes it so.
 */
function toCents(v: string): number | null {
  if (!v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export function CreateTableForm({ defaultName }: { defaultName?: string }) {
  const [name, setName] = useState(defaultName ?? '');
  const [min, setMin] = useState('5');
  const [max, setMax] = useState('200');
  const [buyIn, setBuyIn] = useState('100');
  const [floor, setFloor] = useState('25');
  const [seats, setSeats] = useState('5');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState(false);

  function applyPreset(p: Preset) {
    setMin(String(p.min));
    setMax(String(p.max));
    setBuyIn(String(p.buyIn));
    setFloor(String(p.floor));
    setSeats(String(p.seats));
    setError('');
  }

  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const body = {
      name,
      minBetCents: toCents(min),
      maxBetCents: toCents(max),
      buyInCents: toCents(buyIn),
      minBankrollCents: toCents(floor) ?? 0,
      // A count of chairs, not a cash amount: no x100 anywhere near this.
      seatCount: Number.parseInt(seats, 10),
    };
    try {
      const r = await api<Created>('/api/tables', { method: 'POST', body });
      setCreated(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the table.');
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <div className="tcard">
        <h2 className="lobby__h2">{created.stakes.name} is open</h2>
        <p className="lobby__sub">
          {formatCents(created.stakes.minBetCents)}–{formatCents(created.stakes.maxBetCents)} blinds · buy-in{' '}
          {formatCents(created.stakes.buyInCents)} · {created.stakes.seatCount} seats
        </p>
        {created.warnings.map((w) => (
          <p className="pill pill--warn">{w}</p>
        ))}
        <p className="lobby__fine">
          Nobody can find this table in the lobby. It is reachable only through the button below or by mentioning{' '}
          <code>@JackedBot</code> in a group chat.
        </p>
        <div className="form__row">
          <a className="btn btn--primary" href={created.webAppUrl}>
            Open my table
          </a>
          <button
            className="btn btn--ghost"
            onClick={() => {
              navigator.clipboard
                ?.writeText(created.shareUrl)
                .then(() => setCopied(true))
                .catch(() => setCopied(false));
            }}
          >
            {copied ? 'Link copied' : 'Copy invite link'}
          </button>
        </div>
        <p className="lobby__fine">{created.inlineHint}</p>
        <p className="lobby__fine">
          The share link above works when pasted into a chat; the inline picker is what puts a Join button in front of a
          group.
        </p>
      </div>
    );
  }

  return (
    <form className="tcard form" onSubmit={submit}>
      <h2 className="lobby__h2">Private table</h2>
      <p className="lobby__sub">Unlisted, invite-only. Your own blinds and buy-in.</p>

      <div className="form__row">
        <label className="form__field">
          <span>Table name</span>
          <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="Friday night" maxLength={48} required />
        </label>
      </div>

      <div className="form__row">
        {[
          ['Min bet $', min, setMin],
          ['Max bet $', max, setMax],
          ['Buy-in $', buyIn, setBuyIn],
          ['Seat min $', floor, setFloor],
        ].map(([label, value, set]) => (
          <label className="form__field">
            <span>{label as string}</span>
            <input
              inputmode="decimal"
              value={value as string}
              onInput={(e) => (set as (v: string) => void)((e.target as HTMLInputElement).value)}
              required
            />
          </label>
        ))}
        <label className="form__field form__field--sm">
          <span>Seats</span>
          <select value={seats} onChange={(e) => setSeats((e.target as HTMLSelectElement).value)}>
            {[1, 2, 3, 4, 5].map((n) => (
              <option value={String(n)}>{n}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="form__row">
        {PRESETS.map((p) => (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => applyPreset(p)}>
            {p.label}
          </button>
        ))}
      </div>

      {error ? <p className="alert">{error}</p> : null}

      <button className="btn btn--gold btn--block" type="submit" disabled={busy}>
        {busy ? 'Creating…' : 'Create private table'}
      </button>
      <p className="lobby__fine">
        Play money only. Chips are bought with Telegram Stars and can never leave the game — there is no cashout, transfer
        or prize.
      </p>
    </form>
  );
}
