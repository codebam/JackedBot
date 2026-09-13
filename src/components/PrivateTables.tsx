// =============================================================================
// "Your private tables", rendered from the CLIENT session.
//
// This section used to be server-rendered from `me`, and `me` only exists when SSR
// can validate an `?initData=` query parameter. Telegram hands initData to the
// WebApp *client object*, not to the URL, so for a real Mini App launch the section
// was simply absent - the same false negative that produced the inert Join button
// (ded99de) and the table-page "open inside Telegram" nag (25fa085). A Close button
// inside an SSR-only list would have been unreachable for exactly the person who
// needs it: the owner.
//
// So the list is fetched from GET /api/tables, which returns the caller's own
// private tables from their validated session, and closing is a POST followed by a
// local removal. No reload: a reload would re-run the lobby's public-table queries
// to learn something this component already knows.
// =============================================================================
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { api, ApiError, humanError } from '../lib/client/api.ts';
import { formatCents } from '../shared/money.ts';

interface PrivateTable {
  id: string;
  name: string;
  minBetCents: number;
  maxBetCents: number;
  buyInCents: number;
  seatCount: number;
  activeSeats: number;
  status: string;
  role: 'owner' | 'member';
}

/**
 * Failures that legitimately mean "there is no private list to show you".
 *
 * A visitor in a plain browser, or a Mini App whose initData has not landed yet,
 * has no list - and SessionGate already owns saying so. Everything else (a 500, a
 * dropped connection) is a real failure and must not be dressed up as an empty
 * list, which is what a blanket `catch` did: an owner whose table disappeared had
 * no way to tell "I have none" from "the read broke".
 */
function isAbsence(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  return e.status === 401 || e.status === 403 || e.code.startsWith('INIT_DATA') || e.code === 'AGE_GATE_REQUIRED';
}

export function PrivateTables() {
  const [rows, setRows] = useState<PrivateTable[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  /** Id of the table whose inline "are you sure?" is armed. */
  const [arming, setArming] = useState('');
  /** Name of the table just closed, so removing the row still confirms the tap. */
  const [closedName, setClosedName] = useState('');
  const confirmRef = useRef<HTMLButtonElement>(null);
  const aliveRef = useRef(true);

  const load = useCallback(async () => {
    setError('');
    try {
      const r = await api<{ privateTables?: PrivateTable[] }>('/api/tables');
      if (aliveRef.current) setRows(r.privateTables ?? []);
    } catch (e) {
      if (!aliveRef.current) return;
      setRows([]);
      if (!isAbsence(e)) setError(humanError(e));
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    return () => {
      aliveRef.current = false;
    };
  }, [load]);

  // Arm a confirmation instead of closing. `window.confirm()` put one tap between
  // the owner and an irreversible POST, and a native dialog is not guaranteed
  // inside a Telegram WebView - on a host that suppresses it, the destructive
  // action would have fired on the first tap with no prompt at all. An inline
  // second step cannot be suppressed, is reachable by keyboard, and states the
  // consequence where the owner is looking.
  function arm(t: PrivateTable) {
    setClosedName('');
    setArming(t.id);
    // Move focus onto the destructive button, so Enter confirms and the row is
    // operable without a pointer. Without this a keyboard user arms the
    // confirmation and focus stays behind it, up in the list.
    requestAnimationFrame(() => confirmRef.current?.focus());
  }

  async function closeTable(t: PrivateTable) {
    setBusy(t.id);
    setError('');
    try {
      await api(`/api/tables/${t.id}/close`, { method: 'POST', body: {} });
      setRows((prev) => (prev ?? []).filter((r) => r.id !== t.id));
      setArming('');
      // The vanishing row was the only signal that anything happened, and it
      // vanishes with it - closing your last table looked like the section had
      // simply failed to load. Say what closed.
      setClosedName(t.name);
    } catch (e) {
      setError(humanError(e));
      setArming('');
    } finally {
      setBusy('');
    }
  }

  // null = unknown yet. Render nothing rather than an empty-state that flashes and
  // then fills in. Once a closure or an error is being reported we stay mounted,
  // even if that is what emptied the list.
  if ((!rows || rows.length === 0) && !closedName && !error) return null;

  return (
    <section class="lobby__private">
      <h2 class="lobby__h2">Your private tables</h2>
      <p class="lobby__sub">Unlisted. Share one by typing @JackedBot in a chat and picking it.</p>
      {error ? (
        <p class="alert" role="alert">
          {error}{' '}
          <button type="button" class="lobby__retry" onClick={() => void load()}>
            Try again
          </button>
        </p>
      ) : null}
      {closedName ? (
        <p class="lobby__closed" role="status">
          Closed “{closedName}”. It no longer appears in the lobby or the @JackedBot picker.
        </p>
      ) : null}
      {rows && rows.length > 0 ? (
        <ul class="tcards">
          {rows.map((t) => (
            <li class="tcard" key={t.id}>
              <div class="tcard__top">
                <b>{t.name}</b>
                <span class="badge">{t.role === 'owner' ? 'yours' : 'invited'}</span>
              </div>
              <p class="lobby__fine">
                {formatCents(t.minBetCents)}–{formatCents(t.maxBetCents)} · {t.activeSeats}/{t.seatCount} seated
              </p>
              {arming === t.id ? (
                <div class="tcard__confirm" onKeyDown={(e) => e.key === 'Escape' && setArming('')}>
                  <p class="tcard__confirm-text" id={`close-${t.id}`}>
                    Close “{t.name}”? Nobody can join it again, and it leaves your lobby and the @JackedBot picker.
                    Seated players keep their seat, and a hand in progress settles normally.
                  </p>
                  <div class="tcard__actions">
                    <button
                      type="button"
                      ref={confirmRef}
                      class="btn btn--danger btn--sm"
                      disabled={busy === t.id}
                      aria-describedby={`close-${t.id}`}
                      onClick={() => closeTable(t)}
                    >
                      {busy === t.id ? 'Closing…' : 'Close table'}
                    </button>
                    <button type="button" class="btn btn--ghost btn--sm" disabled={busy === t.id} onClick={() => setArming('')}>
                      Keep it
                    </button>
                  </div>
                </div>
              ) : (
                <div class="tcard__actions">
                  <a class="btn btn--primary" href={`/table/${t.id}?invite=1`}>
                    Open table
                  </a>
                  {t.role === 'owner' ? (
                    <button type="button" class="btn btn--ghost btn--sm" onClick={() => arm(t)}>
                      Close
                    </button>
                  ) : null}
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
