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
import { useEffect, useState } from 'preact/hooks';
import { api, humanError } from '../lib/client/api.ts';
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

export function PrivateTables() {
  const [rows, setRows] = useState<PrivateTable[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    let alive = true;
    api<{ privateTables?: PrivateTable[] }>('/api/tables')
      .then((r) => {
        if (alive) setRows(r.privateTables ?? []);
      })
      .catch(() => {
        // No session, or a plain browser. That is the absence of a private-table
        // list, not an error to shout about - SessionGate reports session state.
        if (alive) setRows([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function closeTable(t: PrivateTable) {
    const sure = confirm(
      `Close “${t.name}”?\n\nNobody will be able to join it again, and it leaves your lobby and the @JackedBot picker. Players already seated keep their seat until they leave, and a hand in progress settles normally.`,
    );
    if (!sure) return;
    setBusy(t.id);
    setError('');
    try {
      await api(`/api/tables/${t.id}/close`, { method: 'POST', body: {} });
      setRows((prev) => (prev ?? []).filter((r) => r.id !== t.id));
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy('');
    }
  }

  // null = unknown yet. Render nothing rather than an empty-state that flashes and
  // then fills in.
  if (!rows || rows.length === 0) return null;

  return (
    <section class="lobby">
      <h2 class="lobby__h2">Your private tables</h2>
      <p class="lobby__sub">Unlisted. Share one by typing @JackedBot in a chat and picking it.</p>
      {error ? <p class="alert">{error}</p> : null}
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
            <div class="tcard__actions">
              <a class="btn btn--primary" href={`/table/${t.id}?invite=1`}>
                Open table
              </a>
              {t.role === 'owner' ? (
                <button type="button" class="btn btn--ghost btn--sm" disabled={busy === t.id} onClick={() => closeTable(t)}>
                  {busy === t.id ? 'Closing…' : 'Close'}
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
