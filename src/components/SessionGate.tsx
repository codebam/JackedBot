// =============================================================================
// SessionGate — the client-side half of the first-visit bootstrap.
//
// Why this exists: the lobby resolved identity from the `tgWebAppData` query
// parameter during SSR. That parameter is not reliably present (Telegram injects
// initData into the *client* object, and it disappears from the URL after any
// navigation), so a genuine Mini App session could render "Open this page inside
// Telegram" with no age gate and no way forward — the exact dead end users hit.
//
// Now SSR is only a fast path. This island always runs, asks the server who we are
// using `Telegram.WebApp.initData` (which the server verifies with the bot token's
// HMAC), and surfaces the age gate when it is still open.
// =============================================================================
import { useEffect, useState } from 'preact/hooks';
import { followTelegramStartParam } from '../lib/client/deeplink.ts';
import type { ComponentChildren } from 'preact';
import { AgeGate } from './AgeGate.tsx';
import { api, ApiError } from '../lib/client/api.ts';
import { getInitData, isInTelegram, haptic } from '../lib/client/telegram.ts';

interface Session {
  bankrollCents: number;
  ageAccepted: boolean;
  ageStatement: string;
  welcomeGranted: boolean;
  needsRebuy?: boolean;
}

export interface SessionGateProps {
  /** Whether SSR already resolved an identity (a fast path, never a requirement). */
  serverResolved: boolean;
  serverAgeAccepted?: boolean;
  houseWarning: string;
  starsLabel: string;
  /** Shown only while the client check is in flight or has failed. */
  pendingNotice?: string;
  onSession?: (s: Session) => void;
  /**
   * Content to show once the player is through. Rendering children was never
   * implemented, so `<SessionGate><SomeForm client:load /></SessionGate>` silently
   * dropped the island: the props type had no `children`, JSX accepted it anyway,
   * and the page rendered its header and nothing else.
   */
  children?: ComponentChildren;
}

type Phase = 'checking' | 'gated' | 'ok' | 'no-session';

export function SessionGate({ serverResolved, serverAgeAccepted, houseWarning, starsLabel, pendingNotice, onSession, children }: SessionGateProps) {
  // Start CLOSED. Mounting the overlay optimistically (as this used to) flashed the
  // 18+ dialog at players who had already accepted it, then hid it a moment later.
  const [phase, setPhase] = useState<Phase>(serverResolved && serverAgeAccepted === true ? 'ok' : 'checking');
  const [statement, setStatement] = useState<string>('');

  useEffect(() => {
    let alive = true;

    // A deep link (t.me/<bot>?startapp=t_<id>) always lands on the Main Screen URL,
    // which is `/`. Route to the invited table first: authenticating the lobby we are
    // about to leave is a wasted round trip. The param is launch-scoped and this gate
    // hydrates on every page, so followTelegramStartParam spends each value once -
    // otherwise a stale start_param bounces every later page (/new-table, the lobby)
    // back to the launch route.
    if (followTelegramStartParam()) return;

    async function boot() {
      // Outside Telegram there is no initData to send; say so rather than
      // spinning on 401s.
      if (!isInTelegram() && !getInitData()) {
        // A plain browser, not Telegram. Say so once, instead of spinning on 401s.
        if (alive) setPhase('no-session');
        return;
      }
      try {
        const s = await api<Session>('/api/session', { method: 'POST', body: {} });
        if (!alive) return;
        onSession?.(s);
        setStatement(s.ageStatement);
        setPhase(s.ageAccepted ? 'ok' : 'gated');
        if (!s.ageAccepted) haptic('light');
      } catch (e) {
        if (!alive) return;
        // 428 is the age gate answering through the API; anything else means the
        // session really is unusable.
        const isGate = e instanceof ApiError && (e.code === 'AGE_GATE_REQUIRED' || e.status === 428);
        setPhase(isGate ? 'gated' : 'no-session');
      }
    }

    // SSR already resolved an accepted adult: skip the round trip entirely.
    if (serverResolved && serverAgeAccepted === true) return;
    void boot();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (phase === 'gated') {
    return (
      <AgeGate
        statement={statement || 'I am 18 or older and understand these chips are play money with no cash value.'}
        houseWarning={houseWarning}
        starsLabel={starsLabel}
        onAccepted={() => {
          // Reload so SSR and every island see the now-authenticated, now-gated-in
          // state from the server instead of trusting a client-side flag.
          window.location.reload();
        }}
      />
    );
  }

  // The notice is owned by this component so it can never outlive the check that
  // produced it — a page-level banner keyed on SSR state used to sit there saying
  // "open in Telegram" long after the client had authenticated.
  if (phase === 'checking' && pendingNotice) return <p class="alert">{pendingNotice}</p>;
  if (phase === 'no-session' && pendingNotice) return <p class="alert">{pendingNotice}</p>;
  // 'ok' - and also the no-notice variants of checking/no-session, so a page that
  // passes no pendingNotice still shows its content rather than a blank screen.
  return <>{children ?? null}</>;
}
