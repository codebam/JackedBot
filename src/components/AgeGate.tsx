// First-visit age + play-money attestation. Recorded in D1 (not localStorage) so it
// follows the player across devices and is auditable.
//
// This is a legal surface, so it behaves like a real modal: it takes focus on open,
// keeps focus inside itself, and marks everything behind it inert. Without that, a
// keyboard user could Tab straight past the 18+ gate into the lobby it was covering,
// and a screen reader could read the tables "behind" a dialog that claimed to be
// modal. It is also deliberately two steps - tick, then enter - so a stray tap while
// scrolling a phone cannot accept an age declaration on someone's behalf.
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, humanError } from '../lib/client/api.ts';
import { haptic } from '../lib/client/telegram.ts';

export interface AgeGateProps {
  statement: string;
  houseWarning: string;
  starsLabel: string;
  onAccepted: () => void;
}

/** Focusable descendants, for the trap. The card has no hidden branches. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Never inert these: they are not rendered content and `<head>` holds the host bridge. */
const SKIP_INERT = new Set(['HEAD', 'SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'TEMPLATE', 'NOSCRIPT']);

export function AgeGate({ statement, houseWarning, starsLabel, onAccepted }: AgeGateProps) {
  const [busy, setBusy] = useState(false);
  const [ticked, setTicked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // Focus the panel on open, and make everything outside it inert. Walking up from
  // the gate and inerting each ancestor's siblings is what keeps the rest of the
  // page unreachable without this component having to know the page's structure.
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    card.focus();

    const marked: HTMLElement[] = [];
    let node: HTMLElement | null = card;
    while (node && node.parentElement) {
      for (const sib of Array.from(node.parentElement.children)) {
        if (sib === node || !(sib instanceof HTMLElement) || SKIP_INERT.has(sib.tagName)) continue;
        if (sib.hasAttribute('inert')) continue; // someone else's; leave it alone
        sib.setAttribute('inert', '');
        marked.push(sib);
      }
      node = node.parentElement;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; // the overlay is the only scrollable thing now

    return () => {
      for (const el of marked) el.removeAttribute('inert');
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  // Keep Tab inside the card. `inert` stops the background being reachable, but
  // without a trap focus would leave the dialog for the browser chrome and the
  // overlay would no longer be the thing being operated.
  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== 'Tab') return;
    const card = cardRef.current;
    if (!card) return;
    const items = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    const inside = active instanceof HTMLElement && card.contains(active);
    if (e.shiftKey && (!inside || active === first)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (!inside || active === last)) {
      e.preventDefault();
      first.focus();
    }
  }

  async function accept() {
    if (busy || !ticked) return;
    setBusy(true);
    setError(null);
    haptic('medium');
    try {
      await api('/api/age-gate', { method: 'POST', body: { accept: true, statement } });
      haptic('success');
      // Stay busy: the caller reloads, and re-enabling the button mid-navigation
      // would leave a live "accept" control on screen.
      onAccepted();
    } catch (e) {
      setError(humanError(e));
      haptic('error');
      setBusy(false);
    }
  }

  return (
    <div class="gate" onKeyDown={onKeyDown}>
      <div
        class="gate__card"
        ref={cardRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="gate-title"
        aria-describedby="gate-lede"
      >
        <div class="gate__badge" aria-hidden="true">
          18+
        </div>
        <h1 class="gate__title" id="gate-title">
          Blackjack with play money
        </h1>
        <p class="gate__lede" id="gate-lede">
          Chips are a game currency. They are <b>never</b> redeemable for Telegram Stars, TON, cash or any prize — there is no
          withdrawal path in this app.
        </p>
        <ul class="gate__list">
          <li>
            <span aria-hidden="true">1</span>
            <p>
              1 Telegram Star buys <b>{starsLabel}</b> of chips
            </p>
          </li>
          <li>
            <span aria-hidden="true">2</span>
            <p>New accounts get a free starter stack to try the table</p>
          </li>
          <li>
            <span aria-hidden="true">3</span>
            <p>Losing costs you nothing but the hand. There is no debt and no cashout.</p>
          </li>
        </ul>

        {/* A real control. It used to be `checked disabled aria-hidden` — a box that
            was already ticked before the player arrived, which reads as consent that
            was given when it was not, and which they could not operate. */}
        <label class="gate__confirm">
          <input type="checkbox" checked={ticked} onChange={() => setTicked((v) => !v)} aria-describedby="gate-why" />
          <span>{statement}</span>
        </label>

        {error ? (
          <p class="gate__error" role="alert">
            {error}
          </p>
        ) : null}

        {/* Says why the button below is disabled, which is otherwise unexplained:
            a greyed-out "enter" on a legal gate looks like a broken page. */}
        <p class={ticked || error ? 'gate__why gate__why--done' : 'gate__why'} id="gate-why">
          Tick the box to confirm you are 18 or older, then tap enter.
        </p>

        <button class="btn btn--primary btn--block" type="button" onClick={accept} disabled={busy || !ticked}>
          {busy ? 'Saving…' : 'I am 18 or older — enter'}
        </button>
        <p class="gate__fine">{houseWarning}</p>
      </div>
    </div>
  );
}
