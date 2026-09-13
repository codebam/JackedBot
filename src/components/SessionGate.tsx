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
import { api, ApiError, humanError } from '../lib/client/api.ts';
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

/**
 * `checking` is in flight. The three terminal states used to be one `no-session`,
 * which rendered the caller's *pending* string - so a plain browser and a rejected
 * session both said "Restoring your Telegram session..." forever, describing work
 * that had already finished and failed. They are different situations with
 * different remedies, so they are different phases.
 */
type Phase = 'checking' | 'gated' | 'ok' | 'not-telegram' | 'auth-failed';

export function SessionGate({ serverResolved, serverAgeAccepted, houseWarning, starsLabel, pendingNotice, onSession, children }: SessionGateProps) {
  // Start CLOSED. Mounting the overlay optimistically (as this used to) flashed the
  // 18+ dialog at players who had already accepted it, then hid it a moment later.
  const [phase, setPhase] = useState<Phase>(serverResolved && serverAgeAccepted === true ? 'ok' : 'checking');
  const [statement, setStatement] = useState<string>('');
  /** The server's own reason for a failed session, via humanError. */
  const [failure, setFailure] = useState<string>('');
  /** Bumped by the retry button; the boot effect depends on it. */
  const [attempt, setAttempt] = useState(0);

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
        // A plain browser, not Telegram. There is no initData to send, so retrying
        // cannot help and the copy must not imply that it can.
        if (alive) setPhase('not-telegram');
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
        if (isGate) {
          setPhase('gated');
          return;
        }
        // Surface the server's own reason rather than inventing one: a stale
        // initData, a bad hash and a dropped connection need different responses,
        // and RECOVERABLE in api.ts already words them.
        setFailure(humanError(e));
        setPhase('auth-failed');
      }
    }

    // SSR already resolved an accepted adult: skip the round trip entirely.
    if (serverResolved && serverAgeAccepted === true) return;
    void boot();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

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
  //
  // `pendingNotice` is the opt-in: a page that passes none (the table, which draws
  // its own connection states) gets its children back instead of a blank screen.
  const wantsNotice = pendingNotice !== undefined;

  if (wantsNotice && phase === 'checking') {
    // Gold, not the error red: nothing has gone wrong yet. Announced politely,
    // because a screen reader user otherwise gets silence and then a page change.
    return (
      <p class="alert alert--gold" role="status">
        {pendingNotice}
      </p>
    );
  }

  if (wantsNotice && phase === 'not-telegram') {
    // Honest about why retrying is not offered: there is no initData to retry with.
    return (
      <p class="alert alert--gold">
        You are in a regular browser, so Telegram has not signed you in and playing is not possible here. Open JackedBot
        from @JackedBot inside Telegram. Nothing on this page is broken — it just cannot know who you are.
      </p>
    );
  }

  if (wantsNotice && phase === 'auth-failed') {
    // Actionable. A failed session used to be indistinguishable from a slow one and
    // offered nothing to do but close the app; a stale initData or a dropped
    // connection usually succeeds on a second attempt.
    return (
      <p class="alert" role="alert">
        Could not sign you in{failure ? `: ${failure}` : ''}.{' '}
        <button
          type="button"
          class="btn btn--sm btn--ghost"
          onClick={() => {
            // Back to 'checking' first, so the retry is visibly in flight instead of
            // leaving a stale error on screen until the request lands.
            setPhase('checking');
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </button>
      </p>
    );
  }

  // 'ok' - and the no-notice variants of every other phase, so a page that passes
  // no pendingNotice still shows its content rather than a blank screen.
  return <>{children ?? null}</>;
}
