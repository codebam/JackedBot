// CreateTableForm — the "full control" stakes form for a private table.
//
// Why this is a Mini App form and not a chat conversation: six fields with
// relationships between them (max >= min, buy-in >= min bet, seats 1-5) cannot be
// typed reliably into a message, and the validation lives in one place
// (`validateStakes`, shared with POST /api/tables) so the form cannot accept what
// the server would reject. Dollar inputs are converted to integer cents here and
// the server still has the final say.
//
// The browser does NOT re-run that validator. It imports `STAKE_LIMITS` — the same
// constant table the server reads — purely to *state the rules up front* and to
// route the server's own error code back to the field it names. Judging a stakes
// object in the client would be a second copy of a money rule, and the two would
// drift; the server remains the only thing that decides.
import { useRef, useState } from 'preact/hooks';
import { api, ApiError } from '../lib/client/api.ts';
import { formatCents } from '../shared/money.ts';
import { STAKE_LIMITS } from '../lib/stakes.ts';

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

type Field = 'name' | 'min' | 'max' | 'buyIn' | 'floor' | 'seats';

/**
 * Which field a server rejection is about, from the code POST /api/tables returns.
 *
 * Only codes that name exactly one field are mapped. `STAKE_OUT_OF_BAND` is left
 * to the page-level alert on purpose: it covers four different inputs and guessing
 * which one from the message text would be as brittle as it is unnecessary.
 */
const CODE_TO_FIELD: Record<string, Field> = {
  NAME_REQUIRED: 'name',
  NAME_TOO_LONG: 'name',
  MAX_BELOW_MIN: 'max',
  BUY_IN_BELOW_MIN_BET: 'buyIn',
  SEAT_FLOOR_BELOW_MIN_BET: 'floor',
  SEAT_COUNT_INVALID: 'seats',
};

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

const band = (b: { lo: number; hi: number }) => `${formatCents(b.lo)}–${formatCents(b.hi)}`;

export function CreateTableForm({ defaultName }: { defaultName?: string }) {
  const [name, setName] = useState(defaultName ?? '');
  const [min, setMin] = useState('5');
  const [max, setMax] = useState('200');
  const [buyIn, setBuyIn] = useState('100');
  const [floor, setFloor] = useState('25');
  const [seats, setSeats] = useState('5');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** Field the server's last rejection was about, so the error lands beside it. */
  const [errorField, setErrorField] = useState<Field | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  /** 'idle' | 'copied' | 'failed' — a silent clipboard is a dead end, not a no-op. */
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const fieldRefs = useRef<Partial<Record<Field, HTMLInputElement | HTMLSelectElement | null>>>({});

  function applyPreset(p: Preset) {
    setMin(String(p.min));
    setMax(String(p.max));
    setBuyIn(String(p.buyIn));
    setFloor(String(p.floor));
    setSeats(String(p.seats));
    setError('');
    setErrorField(null);
  }

  /** Clear a field's own error as soon as the player edits it. */
  function edit(field: Field, value: string, set: (v: string) => void) {
    set(value);
    if (errorField === field) {
      setError('');
      setErrorField(null);
    }
  }

  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setErrorField(null);
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
      const message = err instanceof ApiError ? err.message : 'Could not create the table. Try again.';
      const field = err instanceof ApiError ? CODE_TO_FIELD[err.code] : undefined;
      setError(message || 'Could not create the table. Try again.');
      setErrorField(field ?? null);
      // Move focus to the offending field: on a phone the keyboard is up and the
      // alert is off-screen, so an error nobody is looking at reads as a hang.
      if (field) fieldRefs.current[field]?.focus();
    } finally {
      setBusy(false);
    }
  }

  async function copyInvite(url: string) {
    try {
      // Feature-detect first. `navigator.clipboard?.writeText(url).then(...)`
      // short-circuits the WHOLE chain when clipboard is undefined, so a browser
      // without the async clipboard API silently did nothing at all.
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
      await navigator.clipboard.writeText(url);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }

  if (created) {
    return (
      <div className="tcard">
        <h2 className="lobby__h2">{created.stakes.name} is open</h2>
        <p className="lobby__sub">
          {formatCents(created.stakes.minBetCents)}–{formatCents(created.stakes.maxBetCents)} bets · buy-in{' '}
          {formatCents(created.stakes.buyInCents)} · {created.stakes.seatCount} seats
        </p>
        {created.warnings.map((w, i) => (
          <p className="pill pill--warn" key={i}>
            {w}
          </p>
        ))}
        <p className="lobby__fine">
          Nobody can find this table in the lobby. It is reachable only through the button below or by mentioning{' '}
          <code>@JackedBot</code> in a group chat.
        </p>
        <div className="form__row">
          <a className="btn btn--primary" href={created.webAppUrl}>
            Open my table
          </a>
          <button type="button" className="btn btn--ghost" onClick={() => void copyInvite(created.shareUrl)}>
            {copyState === 'copied' ? 'Link copied ✓' : 'Copy invite link'}
          </button>
        </div>
        <p className="form__copied" role="status">
          {copyState === 'copied'
            ? 'Invite link copied — paste it into any chat.'
            : copyState === 'failed'
              ? 'Copying is blocked here. Long-press the link below to copy it yourself.'
              : 'Anyone opening this link is admitted to the table, so share it only with your group.'}
        </p>
        {/* Always rendered, not only on failure: a clipboard that is unavailable
            without telling us would otherwise leave no way off this screen. */}
        <p className="form__url">
          <code>{created.shareUrl}</code>
        </p>
        <p className="lobby__fine">{created.inlineHint}</p>
        <p className="lobby__fine">
          The share link above works when pasted into a chat; the inline picker is what puts a Join button in front of a
          group.
        </p>
      </div>
    );
  }

  const moneyFields: { field: Field; label: string; value: string; set: (v: string) => void; hint: string }[] = [
    { field: 'min', label: 'Min bet $', value: min, set: setMin, hint: `Smallest wager allowed. ${band(STAKE_LIMITS.minBetCents)}.` },
    { field: 'max', label: 'Max bet $', value: max, set: setMax, hint: `Largest wager allowed. ${band(STAKE_LIMITS.maxBetCents)}. Cannot be below the min bet.` },
    { field: 'buyIn', label: 'Buy-in $', value: buyIn, set: setBuyIn, hint: `Chips a player gets for sitting. ${band(STAKE_LIMITS.buyInCents)}. Must cover at least one min bet.` },
    { field: 'floor', label: 'Seat min $', value: floor, set: setFloor, hint: `Bankroll needed to sit. 0 lets anyone in. Otherwise ${band(STAKE_LIMITS.seatFloorCents)} and at least the min bet.` },
  ];

  return (
    // Native validation stays on deliberately. It catches the one case the server
    // words badly - an empty field comes back as "must be whole cent amounts" - and
    // it catches it instantly, without a round trip. Everything native validation
    // cannot express (max < min, a buy-in that covers no bet) is routed to its field
    // from the server's own error code in submit().
    <form className="tcard form" onSubmit={submit}>
      <h2 className="lobby__h2">Private table</h2>
      <p className="lobby__sub">Unlisted, invite-only. Your own bets and buy-in.</p>

      <div className="form__row">
        <label className="form__field">
          <span>Table name</span>
          <input
            ref={(el) => {
              fieldRefs.current.name = el;
            }}
            value={name}
            onInput={(e) => edit('name', (e.target as HTMLInputElement).value, setName)}
            placeholder="Friday night"
            maxLength={STAKE_LIMITS.nameMaxChars}
            autoComplete="off"
            aria-invalid={errorField === 'name'}
            required
          />
        </label>
      </div>

      <div className="form__row">
        {moneyFields.map((f) => (
          <label className="form__field" key={f.field}>
            <span>{f.label}</span>
            <input
              ref={(el) => {
                fieldRefs.current[f.field] = el;
              }}
              inputmode="decimal"
              autoComplete="off"
              spellcheck={false}
              enterKeyHint="next"
              value={f.value}
              onInput={(e) => edit(f.field, (e.target as HTMLInputElement).value, f.set)}
              aria-invalid={errorField === f.field}
              required
            />
            <span className="form__hint">{f.hint}</span>
          </label>
        ))}
        <label className="form__field form__field--sm" key="seats">
          <span>Seats</span>
          <select
            ref={(el) => {
            fieldRefs.current.seats = el;
          }}
            value={seats}
            onChange={(e) => edit('seats', (e.target as HTMLSelectElement).value, setSeats)}
            aria-invalid={errorField === 'seats'}
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <option value={String(n)} key={n}>
                {n}
              </option>
            ))}
          </select>
          <span className="form__hint">
            {STAKE_LIMITS.seatCount.lo}–{STAKE_LIMITS.seatCount.hi} players.
          </span>
        </label>
      </div>

      <div className="form__row">
        {PRESETS.map((p) => (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => applyPreset(p)} key={p.label}>
            {p.label}
          </button>
        ))}
      </div>

      {error ? (
        <p className="alert" role="alert">
          {errorField ? <b>{moneyFields.find((f) => f.field === errorField)?.label ?? 'Table name'}:</b> : null} {error}
        </p>
      ) : null}

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
