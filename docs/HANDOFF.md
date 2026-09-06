# Known bugs / next up (handoff)

Live: https://jackedbot.codebam.workers.dev · @JackedBot (id 8129851982)
Status: `/start` replies ✅, menu button opens ✅. Tests: 68 unit + 25 workerd.

## 1. `/balance` errors (user-reported, not yet reproduced)
Path: `src/lib/telegram/commands.ts#cmdBalance` → `src/lib/db/tablesRepo.ts#getPlayerSummary`,
`src/lib/db/payments.ts#ledgerTail` + `paymentsForUser`.

Prime suspect: **HTML parse failure**, not SQL. `sendMessage` uses `parse_mode: 'HTML'`
and `cmdBalance` interpolates `esc(...)` into `<b>`/`<i>` — but `formatCents(-250)`
returns `-$2.50`, and the `body` array mixes `''` placeholders from ternaries. Check
next:
- Does `getPlayerSummary` return a row for a user with **no** `user_stats` row?
  (`LEFT JOIN` → summary non-null with zeros; `summary?.bankroll_cents` is read off
  that join, so a brand-new user is fine — but verify `net_cents` is never `null`.)
- Capture the real error: `npx wrangler tail jackedbot --format json`, then POST a
  synthetic `/balance` update with the webhook secret (pattern in git history /
  `scripts/smoke-live.mjs`), and read the exception instead of guessing.
- Note `TelegramApiError` with a 4xx is now ACKed as `dropped_undeliverable`
  (`src/pages/api/telegram/webhook.ts` `DEAD_CHAT`) — a parse error is a 400, so it
  will be **silently dropped**. Widen that regex or log the description first, or
  this bug hides itself.

## 2. Mini App flashes, then still says "Open this page inside Telegram"
Two separate causes, both in the lobby:

**a) The flash** — `src/components/SessionGate.tsx` initialises
`needGate = !serverResolved || serverAgeAccepted === false`, i.e. **true** whenever
SSR had no session. The `<AgeGate>` overlay mounts immediately, then `/api/session`
resolves with `ageAccepted: true` and it unmounts → visible flash.
Fix: start closed and only open after the check says so:
```ts
const [needGate, setNeedGate] = useState(false);   // was: !serverResolved || …
```
`useEffect` already sets it correctly once the response lands; nothing else changes.

**b) The stale message** — `src/pages/index.astro` renders
`{authNote && !me ? <p class="alert">{authNote}</p> : null}`. `me` is SSR-only, so on
every real Mini App open (no `tgWebAppData` in the URL) it stays `null` and the
banner persists even though `SessionGate` has authenticated client-side.
Fix: pass the resolved session back up (`onSession`) and hide the banner once the
client has identity, or simply gate the banner on `!me && !clientResolved`.

Root design point: SSR identity is a **fast path**, never a requirement. Anything
that renders "you are not in Telegram" from SSR state alone will be wrong.

## 3. Smoke guardrail is a false positive
`scripts/smoke-live.mjs` asserts the lobby HTML must not contain the substring
`withdraw` — and the age-gate copy legitimately says *"there is no withdrawal path
in this app."* Assert an **affordance** instead, not prose: e.g. reject
`>\s*withdraw`, `name="withdraw"`, `href="/withdraw`, `data-action="withdraw"`.
(Keep the real check where it belongs: `tests/unit/schema.test.ts` already fails the
build if the schema grows a withdrawal surface.)

## 4. Still open / not done
- `ADMIN_USER_IDS` unset → `/refund` is unusable. Set it to 69148517.
- Age gate not yet accepted by the owner (`users.age_accepted_at` is NULL for
  69148517) — expected until step 2 is fixed and the button is clicked.
- No real Stars payment has been exercised. `createInvoiceLink` verified working with
  `provider_token: ""` and `amount: 1` = 1 Star (amount 100 = 100 Stars — the spec's
  `amount=100` was wrong and would have overcharged 100×).
- Remote D1 has a synthetic probe user `999002` (aged=1) from webhook testing —
  delete it before launch: `DELETE FROM users WHERE telegram_user_id = 999002;`
- `npm run deploy` now runs the smoke suite, so #3 must be fixed before it exits 0.
- Consider `runDurableObjectAlarm` from `cloudflare:test` to test the state machine
  without waiting 15s per phase (pool 0.22 exports it; `fetchMock` no longer exists).

- **Bust relief** (`src/lib/db/relief.ts`): $10 auto-credited at exactly $0, reason `admin_adjust` + `ref_id='bust_relief'`, idempotency key `relief:<user>:<last ledger id>`. Wired into `bootstrapUser`, DO `sit`, DO settlement. `BUST_RELIEF_CENTS=0` restores the old Stars-only NEED_REBUY wall.
