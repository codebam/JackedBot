# Architecture — JackedBot

One Cloudflare Worker ships three things: the Astro SSR site, the Telegram webhook,
and the `Table` Durable Object class.

```
                       ┌──────────────────────────────────────────┐
  Telegram client      │              Worker (jackedbot)          │
 ┌──────────────┐  HTTPS  ┌───────────────┐   ┌──────────────────┐ │
 │  @JackedBot  │◀───────▶│  Astro routes │   │  src/worker.ts   │ │
 │  chat + /buy │         │  /  lobby     │   │  export { Table }│ │
 └──────┬───────┘         │  /table/[id]  │   └───────┬──────────┘ │
        │ webhook         │  /api/*       │           │ stub.fetch │
        ▼                 └──────────────┘           ▼            │
 ┌────────────────              │            ┌───────────────┐    │
│ /api/telegram/  │              │ WebSocket  │  Table DO ×N  │    │
│   webhook       │──────────────┼───────────▶│ shoe, seats,  │    │
│ initData HMAC   │   identity   │  relay     │ round, timers │    │
│ Stars credits   │   from ticket│ (browser   └──────────────┘    │
───────┬─────────┘              │  cannot send      │             │
        │                        ▼  Authorization)   ▼             │
        │                  ┌───────────┐      ┌─────────────┐      │
        └─────────────────▶│    D1     │◀─────┤  alarms +   │      │
             ledger writes │ users     │      │  persisted  │      │
                           │ ledger    │      │  state      │      │
                           │ payments  │      └─────────────┘      │
                           │ rounds    │                           │
                           └───────────┘                           │
                       └──────────────────────────────────────────┘
```

## Why a custom Worker entrypoint

A Durable Object class must be a **top-level export of the Worker module**. Astro's
generated entry only exports `fetch`, so `wrangler.toml` sets
`main = "./src/worker.ts"` and that file exports `Table` next to the Astro handler.

**workerd treats every named export of an entry module as a candidate entrypoint.**
Exporting a plain value (a string constant) fails at boot with
`Incorrect type for map entry 'X': the provided value is not of type 'function or
ExportedHandler'`. Only `Table` and the default handler are exported; shared
constants live in `src/shared/routes.ts`.

## The Table Durable Object

One DO instance per table, addressed by `env.TABLE.idFromName(tableId)`. Max 5 seats.
It is the **only writer** of game state and the only place cards are drawn.

### State machine

```
        ┌──────────┐  15s timer   ┌──────────┐  cards dealt  ┌───────────────┐
        │ BETTING  │─────────────▶│ DEALING  │──────────────▶│ PLAYER_TURNS  │
        └──────────              └──────────┘               └───────┬───────┘
             ▲   no wagers +                    each hand stood/bust │
             │   no sockets ──┐                 ┌───────────────────┘
             │                ▼                 ▼
             │          ┌───────────┐  15s/hand ┌─────────────┐
             │          │   IDLE    │◀──────────│ DEALER_TURN │
             │          └───────────┘           └──────┬──────┘
             │  5min, no sockets                       │ hole revealed,
             │  → disarm, flush, sleep                 │ draw to 17
             │                                         ▼
             └────────── 6s ─────────────┌─────────────┐
                                         │ SETTLEMENT  │
                                         └─────────────┘
```

| Phase | Duration | What happens |
|---|---|---|
| `BETTING` | 15 s | Wagers accepted. Escrow coalesced to one D1 write per seat. |
| `DEALING` | 2 s | 2 cards per funded hand, then dealer up + hole. Blackjack peek resolved here. |
| `PLAYER_TURNS` | 15 s **per hand** | Hit / Stand / Double / Split. Timeout ⇒ **auto-stand**, never auto-play. |
| `DEALER_TURN` | 1 s/card | Hole revealed; draws while ≤ 16, stands on all 17s. |
| `SETTLEMENT` | 6 s | Payouts credited, history written, results broadcast. |

### Timer design (the part that survives eviction)

A Durable Object can be evicted at any moment. `setTimeout` dies with it; a D1
round-trip that outlives the isolate must not depend on one. So every phase carries
an **absolute** `phaseDueAt` epoch and both wakeup mechanisms are armed:

- `setTimeout(dueAt - now)` — precise, drives smooth 15 s countdowns while alive.
- `storage.setAlarm(dueAt + 1500ms)` — durable, fires even after eviction.

Both call `onDeadline()`, which compares `Date.now()` to the stored deadline and is
**idempotent**, so a timer/alarm race or a post-eviction replay can never deal two
rounds. All transitions additionally run through `tx()`, a serialising promise
chain, because DO handlers are re-entrant across `await` points.

The client never trusts its own clock either: every snapshot carries `serverNow`
plus `phaseDueAt`, and `TableSocket` counts down from a monotonic local clock
corrected by the measured offset.

### Hibernation and cost

Sockets are accepted with `ctx.acceptWebSocket()` (the Hibernation API), so an idle
connection costs no isolate time and per-socket state lives in
`serializeAttachment({ userId, socketId })` rather than in memory.

Hibernation only pays off while nothing is scheduled — and an armed alarm or
`setTimeout` keeps the isolate awake and billable. That is the correct trade for a
live table, and it is why an empty table calls `standDown()`: it flushes state to
storage, writes a final lobby heartbeat, **deletes its alarm**, and closes sockets.
With no alarm and no sockets the runtime reclaims it and it costs nothing until
someone sits down again — at which point `ready()` restores the shoe mid-penetration.

### WebSocket flow

1. Island `POST`s `/api/tables/:id/socket` with `initData` → server verifies the
   HMAC signature and mints a **60-second, table-scoped** ticket.
2. Island opens `wss://<host>/api/ws/table/<id>?ticket=…`. Browsers cannot attach an
   `Authorization` header to a WebSocket handshake, which is why the credential is a
   query parameter at all.
3. `src/worker.ts` relays the upgrade **verbatim** to the DO
   (`stub.fetch(request)`) — handshake headers must survive byte-identically.
   `getWebSocketUrl()` does not exist in the current workerd build, so the relay is
   the supported path. Verified live: `scripts/e2e-ws.mjs`.
4. The DO verifies the ticket itself. **The internal hop is not a trust boundary** —
   a compromised route still could not speak for a player.
5. Every state change broadcasts a **full snapshot** (≤ ~4 KB, ≤ 6 sockets). No
   deltas: a late or duplicated frame is then harmless and a reconnect needs no
   resync protocol.

### Redaction

`viewFor()` is the only path from state to wire. It publishes `cardsRemaining` and
the commitment hash but never the shoe permutation, and the dealer array contains
only the upcard until `holeRevealed` flips. Tests assert the serialised JSON contains
no `"order"`, `"pos"` or `"seed"` keys.

**Provably-fair extra:** each shoe publishes `SHA-256(seed || permutation)` when it
is created and reveals `seed` + permutation when it retires, so a player can verify
after the fact that the order was fixed in advance — without ever exposing a future
card during play.

## Money: the ledger is the source of truth

`users.bankroll_cents` is a **cache** maintained only by triggers. Every chip
movement is one statement:

```sql
INSERT OR IGNORE INTO ledger_entries (user_id, cents_delta, reason, idempotency_key, ...)
VALUES (?, ?, ?, ?, ...);
```

That single statement is atomic, idempotent and safe because:

- `UNIQUE(idempotency_key)` + `INSERT OR IGNORE` ⇒ a replayed webhook or retried bet
  is a 0-change no-op, and the bankroll trigger never fires for an ignored insert.
- `ledger_after_insert` moves the bankroll ⇒ no window where money moved but the
  ledger didn't record it.
- `ledger_require_funds` aborts a debit that would overdraw ⇒ two tables racing for
  the same cents cannot both win.
- `ledger_no_update` / `ledger_no_delete` ⇒ the audit trail is append-only.
- `ledger_requires_user` ⇒ no orphan rows (`PRAGMA foreign_keys` is rejected by D1's
  Worker-side API, so integrity is enforced explicitly).

`v_ledger_drift` must always be empty; the hourly cron logs loudly if it isn't, and
nothing auto-"fixes" money.

### Escrow

The stake leaves the bankroll **when the bet is accepted**, not at settlement, so a
player cannot wager the same cents at two tables. Chip taps are coalesced (600 ms)
into one D1 write per seat per window, and `closeBetting()` performs a final
synchronous escrow pass so no hand is ever dealt against money that isn't there.
Doubles and splits debit their extra stake *before* the hand mutates.

### Stars are one-way

`sendInvoice`/`createInvoiceLink` with `currency: "XTR"`, `provider_token: ""`, and
`prices: [{ amount: <star count> }]`. **Stars have no minor unit** — `amount: 100`
buys 100 Stars, not 1.

`successful_payment` → `creditBuyIn()` keyed on `telegram_payment_charge_id`.
The only reverse path is the operator's `refundStarPayment` + clawback, which
refunds first, then removes chips **capped at the balance and floored at the welcome
grant** — chips already gambled away cannot be un-spent, and the free stack is not
proceeds of the charge. Shortfalls are recorded in `admin_actions`.

There is no withdrawal, transfer, redeem or cash-out function anywhere. A unit test
(`tests/unit/schema.test.ts`) fails the build if the schema ever grows one.

## Age gate

`users.age_accepted_at` + the exact statement text, stored in D1 rather than
localStorage so it follows the player across devices and is auditable. The welcome
grant is minted at account creation, but **sitting down** additionally requires the
attestation — a minor can hold chips and never gamble them.

## Rate limiting

`SlidingWindowRateLimiter` in three places: per-user bet/action budgets **inside the
DO** (strongly consistent, one isolate), per-account on the HTTP action fallback, and
per-IP on the webhook. In-Worker route limiters are per-isolate best-effort — the DO
budget is the one that actually binds.
