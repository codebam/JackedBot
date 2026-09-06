// First-visit age + play-money attestation. One click, recorded in D1 (not
// localStorage) so it follows the player across devices and is auditable.
import { useState } from 'preact/hooks';
import { api, humanError } from '../lib/client/api.ts';
import { haptic } from '../lib/client/telegram.ts';

export interface AgeGateProps {
  statement: string;
  houseWarning: string;
  starsLabel: string;
  onAccepted: () => void;
}

export function AgeGate({ statement, houseWarning, starsLabel, onAccepted }: AgeGateProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    if (busy) return;
    setBusy(true);
    setError(null);
    haptic('medium');
    try {
      await api('/api/age-gate', { method: 'POST', body: { accept: true, statement } });
      haptic('success');
      onAccepted();
    } catch (e) {
      setError(humanError(e));
      haptic('error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="gate" role="dialog" aria-modal="true" aria-label="Age verification">
      <div class="gate__card">
        <div class="gate__badge">18+</div>
        <h1 class="gate__title">Blackjack with play money</h1>
        <p class="gate__lede">
          Chips are a game currency. They are <b>never</b> redeemable for Telegram Stars, TON, cash or any prize — there is no
          withdrawal path in this app.
        </p>
        <ul class="gate__list">
          <li>
            <span>1</span>
            <p>
              1 Telegram Star buys <b>{starsLabel}</b> of chips
            </p>
          </li>
          <li>
            <span>2</span>
            <p>New accounts get a free starter stack to try the table</p>
          </li>
          <li>
            <span>3</span>
            <p>Losing costs you nothing but the hand. There is no debt and no cashout.</p>
          </li>
        </ul>
        <label class="gate__confirm">
          <input type="checkbox" checked disabled aria-hidden />
          <span>{statement}</span>
        </label>
        {error ? <p class="gate__error">{error}</p> : null}
        <button class="btn btn--primary btn--block" type="button" onClick={accept} disabled={busy}>
          {busy ? 'Saving…' : 'I am 18 or older — enter'}
        </button>
        <p class="gate__fine">{houseWarning}</p>
      </div>
    </div>
  );
}
