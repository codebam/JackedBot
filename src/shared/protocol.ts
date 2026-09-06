// =============================================================================
// Wire protocol between the Preact island and the Table Durable Object.
// Imported by BOTH sides. Nothing in here may leak shoe contents or a hole card
// — the redaction happens server-side in `toTableView()` before these types are
// ever populated.
// =============================================================================
import type { LegalActions } from '../game/actions.ts';
import type { Outcome } from '../game/settlement.ts';
import type { Phase } from '../game/rules.ts';

export type { Phase } from '../game/rules.ts';

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// client -> table
// ---------------------------------------------------------------------------
export type ClientMessage =
  | { t: 'ping'; ref?: number; t0?: number }
  | { t: 'sit'; seat?: number; ref?: number }
  | { t: 'leave'; ref?: number }
  /** Absolute desired wager for the current betting window, in cents. */
  | { t: 'wager'; chips: number[]; ref?: number }
  | { t: 'clear_wager'; ref?: number }
  | { t: 'action'; a: PlayerAction; ref?: number }
  | { t: 'resume'; ref?: number };

export type PlayerAction = 'hit' | 'stand' | 'double' | 'split';

// ---------------------------------------------------------------------------
// table -> client
// ---------------------------------------------------------------------------
export type ServerMessage =
  | { t: 'hello'; protocol: number; table: TableView; you: YouView; rules: PublicRules; serverNow: number }
  | { t: 'state'; state: TableView; you: YouView }
  | { t: 'event'; kind: EventKind; data: EventData; serverNow: number }
  | { t: 'pong'; ref?: number; t0?: number; serverNow: number }
  | { t: 'ack'; ref?: number; ok: boolean; error?: string; code?: string };

export type EventKind =
  | 'phase'
  | 'deal'
  | 'player_action'
  | 'turn'
  | 'dealer_reveal'
  | 'settlement'
  | 'shoe_retired'
  | 'seat'
  | 'error';

export interface EventData {
  phase?: Phase;
  seq?: number;
  seat?: number | null;
  handKey?: string;
  cards?: number[];
  card?: number;
  action?: PlayerAction;
  outcome?: Outcome;
  legal?: LegalActions;
  message?: string;
  code?: string;
  settlement?: SettlementView;
  /** On `shoe_retired`, the exhausted shoe is revealed for verification. */
  shoe?: { id: string; commitment: string; seed: string; order: number[] };
}

export interface PublicRules {
  decks: number;
  blackjackPays: string;
  dealerStandsOnSoft17: boolean;
  dealerPeeksForBlackjack: boolean;
  doubleOnAnyFirstTwo: boolean;
  doubleAfterSplit: boolean;
  maxSplitHandsPerSeat: number;
  insurance: false;
  surrender: false;
  bettingSeconds: number;
  turnSeconds: number;
}

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------
export interface HandView {
  key: string;
  cards: number[];
  total: number;
  soft: boolean;
  betCents: number;
  status: 'open' | 'stood' | 'bust' | 'blackjack' | 'complete';
  fromSplit: boolean;
  doubled: boolean;
  outcome?: Outcome;
}

export interface SeatView {
  index: number;
  userId: number;
  displayName: string;
  username: string | null;
  /** True while a live socket is attached to this seat. */
  connected: boolean;
  /** Seat is held for a reconnecting player; UI shows a grey "waiting" state. */
  graceUntil: number | null;
  /** Wager committed for the round in progress (0 during BETTING). */
  committedCents: number;
  /** In-progress tray wager during BETTING, before escrow is finalised. */
  pendingChips: number[];
  hands: HandView[];
  isYou: boolean;
}

export interface DealerView {
  upCard: number | null;
  holeRevealed: boolean;
  /** Card list; contains only the upcard until the hole is revealed. */
  cards: number[];
  /** Total for the visible cards only, so the UI can label the upcard. */
  visibleTotal: number | null;
}

export interface ShoeView {
  id: string;
  cardsRemaining: number;
  shoeSize: number;
  penetrationPct: number;
  commitment: string;
}

export interface SettlementHandView {
  seat: number;
  userId: number;
  displayName: string;
  handIndex: number;
  cards: number[];
  betCents: number;
  payoutCents: number;
  netCents: number;
  outcome: Outcome;
}

export interface SettlementView {
  roundId: string;
  seq: number;
  dealerCards: number[];
  dealerTotal: number;
  hands: SettlementHandView[];
}

export interface TableView {
  tableId: string;
  name: string;
  phase: Phase;
  seq: number;
  roundId: string;
  /** Absolute epoch ms; every countdown on the client is `phaseDueAt - serverNow`. */
  phaseDueAt: number;
  phaseDurationMs: number;
  serverNow: number;
  dealer: DealerView;
  shoe: ShoeView;
  seats: (SeatView | null)[];
  settlement: SettlementView | null;
  config: TableConfigView;
  /** Seat index whose turn it is, and the hand within it. */
  activeSeat: number | null;
  activeHandKey: string | null;
  turnDueAt: number | null;
  playerCount: number;
  houseWarning: string;
}

export interface TableConfigView {
  buyInCents: number;
  minBetCents: number;
  maxBetCents: number;
  minBankrollCents: number;
  chips: number[];
  seatCount: number;
}

export interface YouView {
  userId: number;
  seatIndex: number | null;
  /** Cleared play-money bankroll, straight from D1. */
  bankrollCents: number;
  /** Chips currently escrowed at this table (in-flight wager). */
  escrowCents: number;
  /** bankroll - escrow: what hit/double/split can still consume. */
  availableCents: number;
  legal: LegalActions | null;
  ageAccepted: boolean;
  /** Set when the account is out of chips so the UI can surface the buy-in CTA. */
  needsRebuy: boolean;
}

// ---------------------------------------------------------------------------
// lobby (D1-backed, never wakes a DO)
// ---------------------------------------------------------------------------
export interface LobbyTable {
  id: string;
  name: string;
  status: 'open' | 'closing' | 'closed';
  phase: Phase;
  activeSeats: number;
  seatCount: number;
  openSeats: number;
  minBetCents: number;
  maxBetCents: number;
  buyInCents: number;
  /** Chips required to take a seat. The lobby labels tables above the welcome stack. */
  minBankrollCents: number;
  lastActivityAt: string | null;
  /** Compact preview taken from the DO heartbeat snapshot. */
  preview: { dealerUpCard: number | null; potCents: number } | null;
}

export type ApiEnvelope<T> = { ok: true; data: T } | { ok: false; error: string; code: string };
