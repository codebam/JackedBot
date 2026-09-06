// =============================================================================
// Browser-side bridge to the Telegram Mini App host.
//
// Everything here degrades gracefully outside Telegram (plain browser preview,
// curl, unit tests on Node) so the UI is developable without a phone attached —
// but the server still demands real initData, so a fake browser session can never
// place a bet.
// =============================================================================
import type { InvoiceStatus, TelegramWebApp } from '../../shared/telegram-webapp.d.ts';

export function webApp(): TelegramWebApp | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.Telegram?.WebApp;
}

export function isInTelegram(): boolean {
  const app = webApp();
  return Boolean(app && (app.initData || app.initDataUnsafe?.user) && app.version);
}

/**
 * The raw initData string we send to the backend.
 *
 * Preference order matters: `WebApp.initData` is the signed string the host hands
 * us; the `tgWebAppData` query parameter only exists while the URL still carries
 * it (it disappears after any client-side navigation), so it is a fallback for the
 * very first paint, not the primary source.
 */
export function getInitData(): string {
  const app = webApp();
  if (app?.initData) return app.initData;
  if (typeof window === 'undefined') return '';
  const boot = window.__JACKEDBOT__?.initData;
  if (boot) return boot;
  try {
    return new URLSearchParams(window.location.search).get('tgWebAppData') ?? '';
  } catch {
    return '';
  }
}

/** Standard host init: expand to full screen, apply theme, tell Telegram we loaded. */
export function readyTelegramUi(opts: { bgColor?: string; headerColor?: string } = {}): void {
  const app = webApp();
  if (!app) return;
  try {
    app.ready();
    app.expand();
    if (opts.bgColor) app.setBackgroundColor(opts.bgColor);
    if (opts.headerColor) app.setHeaderColor(opts.headerColor);
  } catch {
    /* older hosts or non-Telegram browsers */
  }
}

export function haptic(kind: 'light' | 'medium' | 'heavy' | 'success' | 'error' | 'warning' | 'select'): void {
  const hf = webApp()?.HapticFeedback;
  if (!hf) return;
  try {
    if (kind === 'select') hf.selectionChanged?.();
    else if (kind === 'success' || kind === 'error' || kind === 'warning') hf.notificationOccurred?.(kind);
    else hf.impactOccurred?.(kind);
  } catch {
    /* ignore */
  }
}

/**
 * Raise the native Stars payment sheet.
 *
 * The callback fires when the sheet closes, but it is a *UI* signal only: we never
 * credit chips from here. Chips are credited by the `successful_payment` webhook,
 * which is the only path that has seen a real charge id.
 */
export function openInvoice(link: string): Promise<InvoiceStatus> {
  return new Promise((resolve) => {
    const app = webApp();
    if (!app?.openInvoice) {
      resolve('cancelled');
      return;
    }
    let settled = false;
    const done = (s: InvoiceStatus) => {
      if (settled) return;
      settled = true;
      resolve(s);
    };
    try {
      app.openInvoice(link, done);
    } catch {
      done('failed');
    }
    // Some hosts never invoke the callback (e.g. the user backgrounds the app).
    const onInvoiceClosed = (e: unknown) => {
      const status = (e as { status?: InvoiceStatus })?.status;
      if (status) done(status);
    };
    try {
      app.onEvent('invoiceClosed', onInvoiceClosed);
      setTimeout(() => {
        try {
          app.offEvent('invoiceClosed', onInvoiceClosed);
        } catch {
          /* ignore */
        }
      }, 300_000);
    } catch {
      /* ignore */
    }
  });
}

export function showNotice(message: string, buttons = ['ok']): Promise<string> {
  return new Promise((resolve) => {
    const app = webApp();
    if (!app?.showPopup) {
      // eslint-disable-next-line no-alert
      resolve(window.confirm(message) ? 'ok' : 'cancel');
      return;
    }
    try {
      app.showPopup({ message, buttons: buttons.map((b) => ({ type: b as 'ok', id: b })) }, (id) => resolve(id));
    } catch {
      resolve('ok');
    }
  });
}

export function setViewportVars(): void {
  if (typeof document === 'undefined') return;
  const apply = () => {
    const app = webApp();
    const root = document.documentElement;
    const h = app?.viewportHeight ?? window.innerHeight;
    root.style.setProperty('--app-h', `${h}px`);
    root.style.setProperty('--safe-top', `${app?.safeAreaInsetTop ?? 0}px`);
    root.style.setProperty('--safe-bottom', `${app?.safeAreaInsetBottom ?? 0}px`);
  };
  apply();
  window.addEventListener('resize', apply);
  try {
    webApp()?.onEvent('viewportChanged', apply);
  } catch {
    /* ignore */
  }
}

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
