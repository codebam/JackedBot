// =============================================================================
// Minimal, typed Telegram Bot API client. No SDK dependency: the surface we need
// is ~12 methods and we want explicit control over timeouts (the pre-checkout
// answer must land inside Telegram's 10-second window) and 429 handling.
// =============================================================================

export const TELEGRAM_API_BASE = 'https://api.telegram.org';

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface LabeledPrice {
  label: string;
  amount: number;
}

export interface InlineKeyboardButton {
  text: string;
  web_app?: { url: string };
  url?: string;
  callback_data?: string;
  switch_inline_query_current_chat?: string;
}
export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}
export interface ReplyKeyboardMarkup {
  keyboard: { text: string; request_users?: unknown }[][];
  resize_keyboard?: boolean;
  one_time_keyboard?: boolean;
}

export interface SuccessfulPayment {
  currency: string;
  total_amount: number;
  invoice_payload: string;
  telegram_payment_charge_id: string;
  provider_payment_charge_id: string;
  subscription_expiration_date?: number;
  is_recurring?: boolean;
  is_first_recurring?: boolean;
}

export interface PreCheckoutQuery {
  id: string;
  from: TgUser;
  currency: string;
  total_amount: number;
  invoice_payload: string;
  shipping_option_id?: string;
}

export interface RefundedPayment {
  currency: string;
  total_amount: number;
  invoice_payload: string;
  telegram_payment_charge_id: string;
  provider_payment_charge_id: string;
}

export interface Message {
  message_id: number;
  date: number;
  chat: { id: number; type: string; username?: string; first_name?: string };
  from?: TgUser;
  text?: string;
  successful_payment?: SuccessfulPayment;
  /** Set when Telegram/the provider refunded outside our own /refund command. */
  refunded_payment?: RefundedPayment;
  invoice?: unknown;
  is_test?: boolean;
}

export interface CallbackQuery {
  id: string;
  from: TgUser;
  message?: Message;
  data?: string;
  chat_instance?: string;
}

export interface Update {
  update_id: number;
  message?: Message;
  edited_message?: Message;
  callback_query?: CallbackQuery;
  pre_checkout_query?: PreCheckoutQuery;
}

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly description: string,
    readonly parameters?: { retry_after?: number },
  ) {
    super(`Telegram ${method} failed (${code}): ${description}`);
    this.name = 'TelegramApiError';
  }
}

export interface CallOptions {
  /** Hard cap on the request. Defaults to 8s — inside Telegram's 10s window. */
  timeoutMs?: number;
  /** Follow Telegram's `retry_after` on 429. Off for latency-critical replies. */
  retryOn429?: boolean;
}

export interface InvoiceLink {
  link: string;
}

export class TelegramBot {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!token || !/^\d+:[\w-]+$/.test(token)) {
      throw new Error('TelegramBot: TELEGRAM_BOT_TOKEN does not look like "<bot_id>:<secret>"');
    }
  }

  get botId(): number {
    return Number(this.token.split(':')[0]);
  }

  async call<T>(method: string, payload: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<T> {
    const { timeoutMs = 8_000, retryOn429 = true } = opts;
    const url = `${TELEGRAM_API_BASE}/bot${this.token}/${method}`;
    // Detach the injected fetch into a local binding on purpose. Calling it as
    // `this.fetchImpl(url)` passes the TelegramBot instance as the receiver, and
    // the Workers global `fetch` rejects a foreign `this` with
    //   "Illegal invocation: function called with incorrect `this` reference"
    // which silently broke every sendMessage/reply while still writing the user
    // row first — so /start looked like it was ignored.
    const fetchFn = this.fetchImpl;

    const attempt = async (): Promise<Response> =>
      fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(stripUndefined(payload)),
        // AbortSignal.timeout is available in workerd and Node 18+.
        signal: AbortSignal.timeout(timeoutMs),
      });

    let res = await attempt();
    if (res.status === 429 && retryOn429) {
      const body = (await res.clone().json().catch(() => null)) as
        | { ok: false; parameters?: { retry_after?: number } }
        | null;
      const wait = Math.min(body?.parameters?.retry_after ?? 1, 5);
      await new Promise((r) => setTimeout(r, wait * 1000));
      res = await attempt();
    }

    const json = (await res.json().catch(() => null)) as { ok: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } } | null;
    if (!json) throw new TelegramApiError(method, res.status, `unparseable response (HTTP ${res.status})`);
    if (!json.ok) throw new TelegramApiError(method, json.error_code ?? res.status, json.description ?? 'unknown error', json.parameters);
    return json.result as T;
  }

  // -- bootstrap ------------------------------------------------------------
  getMe() {
    return this.call<TgUser>('getMe', {}, { retryOn429: false });
  }

  setWebhook(url: string, secretToken: string, username: string) {
    return this.call<boolean>('setWebhook', {
      url,
      secret_token: secretToken,
      // Only what we consume; leaving this unset means "everything", which burns
      // webhook throughput on chat-member and reactions updates we ignore.
      allowed_updates: ['message', 'callback_query', 'pre_checkout_query', 'edited_message'],
      drop_pending_updates: false,
      max_connections: 40,
      ip_address: '',
      certificate: '',
    });
  }

  getWebhookInfo() {
    return this.call<{ url: string; pending_update_count: number; last_error_message?: string; last_error_date?: number; max_connections?: number }>(
      'getWebhookInfo',
    );
  }

  setMyCommands(commands: { command: string; description: string }[]) {
    return this.call<boolean>('setMyCommands', { commands, scope: { type: 'default' } });
  }

  /** The Mini App launcher that appears in every user's chat with this bot. */
  setMenuButtonWebApp(url: string, text = 'Play Blackjack', chatId?: number) {
    return this.call<boolean>('setChatMenuButton', {
      ...(chatId ? { chat_id: chatId } : {}),
      menu_button: { type: 'web_app', text, web_app: { url } },
    });
  }

  // -- messaging ------------------------------------------------------------
  sendMessage(chatId: number, text: string, extra: Record<string, unknown> = {}) {
    return this.call<Message>('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  }

  editMessageText(chatId: number, messageId: number, text: string, extra: Record<string, unknown> = {}) {
    return this.call<Message | boolean>('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  }

  answerCallbackQuery(callbackQueryId: string, text?: string, showAlert = false) {
    return this.call<boolean>('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text ? { text: text.slice(0, 200), show_alert: showAlert } : {}),
    });
  }

  // -- payments (Telegram Stars) -------------------------------------------
  /**
   * `currency: "XTR"` + exactly one price item + `provider_token: ""`.
   * Amounts are in *Stars* (1 unit = 1 Star) for XTR, per the Payments docs.
   */
  sendInvoiceStars(chatId: number, p: { title: string; description: string; payload: string; stars: number; startParameter: string }) {
    return this.call<Message>(
      'sendInvoice',
      {
        chat_id: chatId,
        title: p.title,
        description: p.description,
        payload: p.payload,
        provider_token: '',
        currency: 'XTR',
        prices: [{ label: p.title, amount: p.stars }] satisfies LabeledPrice[],
        start_parameter: p.startParameter,
        need_name: false,
        need_phone_number: false,
        need_email: false,
        need_shipping_address: false,
        is_flexible: false,
      },
      { retryOn429: false },
    );
  }

  /** In-Mini-App checkout: returns `tg://...` / `https://t.me/...` link for WebApp.openInvoice(). */
  createInvoiceLinkStars(p: { title: string; description: string; payload: string; stars: number }) {
    return this.call<string>(
      'createInvoiceLink',
      {
        title: p.title,
        description: p.description,
        payload: p.payload,
        provider_token: '',
        currency: 'XTR',
        prices: [{ label: p.title, amount: p.stars }] satisfies LabeledPrice[],
      },
      { retryOn429: false },
    );
  }

  /**
   * Must be answered within 10 seconds of the update arriving or Telegram
   * retransmits the query. `ok: false` aborts the charge and shows `errorMessage`.
   */
  answerPreCheckoutQuery(preCheckoutQueryId: string, ok: boolean, errorMessage?: string) {
    return this.call<boolean>(
      'answerPreCheckoutQuery',
      {
        pre_checkout_query_id: preCheckoutQueryId,
        ok,
        ...(ok ? {} : { error_message: (errorMessage ?? 'Payment could not be completed.').slice(0, 200) }),
      },
      { timeoutMs: 6_000, retryOn429: false },
    );
  }

  /**
   * Stars are refundable by the bot; the *chips* they bought are clawed back in
   * the same D1 transaction by `refundAndClawback()` in lib/db/payments.ts.
   */
  refundStarPayment(userId: number, telegramPaymentChargeId: string) {
    return this.call<boolean>('refundStarPayment', {
      user_id: userId,
      telegram_payment_charge_id: telegramPaymentChargeId,
    });
  }

  getStarTransactions(offset = 0, limit = 100) {
    return this.call<{ transactions: { id: string; transaction_date: number; type: string; charge_id?: string }[]; total_count: number }>(
      'getStarTransactions',
      { offset, limit },
    );
  }
}

function stripUndefined<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

/** HTML-escape anything user-controlled before it reaches sendMessage. */
export function esc(s: string | number | null | undefined): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
