// =============================================================================
// Minimal typed surface for telegram-web-app.js (loaded by the Base layout).
// Only what this app actually calls.
// =============================================================================

export interface WebAppUserLite {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
}

export interface ThemeParams {
  bg_color?: string;
  text_color?: string;
  hint_color?: string;
  link_color?: string;
  button_color?: string;
  button_text_color?: string;
  secondary_bg_color?: string;
}

export type InvoiceStatus = 'paid' | 'cancelled' | 'failed' | 'opened' | 'closed' | 'back';

export interface WebAppInitDataRaw {
  user?: string;
  auth_date?: string;
  hash?: string;
  query_id?: string;
  chat_type?: string;
  start_param?: string;
}

interface HapticFeedback {
  impactOccurred?: (style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft') => void;
  notificationOccurred?: (type: 'error' | 'success' | 'warning') => void;
  selectionChanged?: () => void;
}

export interface TelegramWebApp {
  initData: string;
  initDataUnsafe: WebAppInitDataRaw;
  version: string;
  platform: string;
  colorScheme: 'light' | 'dark';
  themeParams: ThemeParams;
  isExpanded: boolean;
  viewportHeight: number;
  safeAreaInsetTop?: number;
  safeAreaInsetBottom?: number;
  contentSafeAreaInsetTop?: number;
  contentSafeAreaInsetBottom?: number;
  expand: () => void;
  ready: () => void;
  close: () => void;
  enableClosingConfirmation: () => void;
  disableClosingConfirmation: () => void;
  showPopup: (
    params: { title?: string; message: string; buttons: { type: 'ok' | 'close' | 'cancel' | 'default'; id: string; text?: string }[] },
    cb?: (buttonId: string) => void,
  ) => void;
  showAlert: (message: string, cb?: () => void) => void;
  openInvoice: (url: string, cb?: (status: InvoiceStatus) => void) => void;
  openLink: (url: string, params?: { try_instant_view?: boolean }) => void;
  openTelegramLink: (url: string) => void;
  setHeaderColor: (color: string | 'bg_color' | 'secondary_bg_color') => void;
  setBackgroundColor: (color: string | 'bg_color' | 'secondary_bg_color') => void;
  onEvent: (name: string, handler: (e?: unknown) => void) => void;
  offEvent: (name: string, handler: (e?: unknown) => void) => void;
  HapticFeedback?: HapticFeedback;
  BackButton?: { show: () => void; hide: () => void; onClick: (h: () => void) => void; offClick: (h: () => void) => void; isActive: boolean; visible: boolean };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
    /** Server-rendered bootstrap payload injected by the Astro page. */
    __JACKEDBOT__?: {
      initData?: string;
      userId?: number;
      bankrollCents?: number;
      ageAccepted?: boolean;
      houseWarning?: string;
      tableId?: string;
      table?: unknown;
      you?: unknown;
      rules?: unknown;
    };
  }
}

export {};
