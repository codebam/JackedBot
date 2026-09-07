// The client half of deep links. The start param describes the WEBVIEW LAUNCH, but
// Telegram keeps it in `initDataUnsafe.start_param` for every page the session
// visits, so a gate that trusts it on later pages bounces the player back to the
// launch route - the flash that made "Create a private table" look dead after the
// startapp change. These pin the consume-once rules against stubbed globals.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { followTelegramStartParam } from '../../src/lib/client/deeplink.ts';

const KEY = 'jackedbot.followedStartParam';
const TABLE_ID = '0123456789abcdef0123456789abcdef';

function stubLocation(path: string, search = '', hash = '') {
  const replace = vi.fn();
  vi.stubGlobal('location', { pathname: path, search, hash, origin: 'https://app.example', replace });
  return replace;
}

function stubStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
  });
  return map;
}

function stubWebApp(startParam?: string) {
  vi.stubGlobal('window', { Telegram: { WebApp: { initDataUnsafe: { start_param: startParam } } } });
}

describe('followTelegramStartParam (client)', () => {
  beforeEach(() => stubWebApp());
  afterEach(() => vi.unstubAllGlobals());

  it('routes an invite launch that lands on the main screen URL', () => {
    const replace = stubLocation('/', `?tgWebAppStartParam=t_${TABLE_ID}`);
    const store = stubStorage();
    expect(followTelegramStartParam()).toBe(true);
    expect(replace).toHaveBeenCalledWith(`/table/${TABLE_ID}?invite=1`);
    expect(store.get(KEY)).toBe(`t_${TABLE_ID}`);
  });

  it('lands a home launch in place and spends the param', () => {
    const replace = stubLocation('/', '?tgWebAppStartParam=h');
    const store = stubStorage();
    expect(followTelegramStartParam()).toBe(false);
    expect(replace).not.toHaveBeenCalled();
    expect(store.get(KEY)).toBe('h');
  });

  it('does not bounce /new-table to a stale launch param (the create-table flash)', () => {
    // Step 1: the app was launched home-bound and spent the param on the lobby.
    stubLocation('/', '?tgWebAppStartParam=h');
    const store = stubStorage();
    followTelegramStartParam();

    // Step 2: the player navigates to /new-table; the URL carries no param, but
    // the WebApp object still reports the launch value. The form must stay put.
    const replace = stubLocation('/new-table');
    stubWebApp('h');
    expect(followTelegramStartParam()).toBe(false);
    expect(replace).not.toHaveBeenCalled();
    expect(store.get(KEY)).toBe('h');
  });

  it('honours the very first sighting of a stale invite param on the main screen', () => {
    // Some clients deliver the param only via initDataUnsafe, never in the URL.
    const replace = stubLocation('/');
    stubWebApp(`t_${TABLE_ID}`);
    const store = stubStorage();
    expect(followTelegramStartParam()).toBe(true);
    expect(replace).toHaveBeenCalledWith(`/table/${TABLE_ID}?invite=1`);

    // And never again: leaving for the lobby must not get yanked back.
    const replace2 = stubLocation('/');
    expect(followTelegramStartParam()).toBe(false);
    expect(replace2).not.toHaveBeenCalled();
  });

  it('follows a re-tapped link even when the same param was spent', () => {
    const replace = stubLocation('/', `?tgWebAppStartParam=t_${TABLE_ID}`);
    stubStorage({ [KEY]: `t_${TABLE_ID}` });
    expect(followTelegramStartParam()).toBe(true);
    expect(replace).toHaveBeenCalledWith(`/table/${TABLE_ID}?invite=1`);
  });

  it('stays silent on params the codec does not own', () => {
    const replace = stubLocation('/new-table');
    stubWebApp('anything_else');
    stubStorage();
    expect(followTelegramStartParam()).toBe(false);
    expect(replace).not.toHaveBeenCalled();
  });

  it('without usable storage, trusts only URL delivery', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
    });
    const stale = stubLocation('/new-table');
    stubWebApp('h');
    expect(followTelegramStartParam()).toBe(false);
    expect(stale).not.toHaveBeenCalled();

    const fresh = stubLocation('/', '?tgWebAppStartParam=t_22222222222222222222222222222222');
    expect(followTelegramStartParam()).toBe(true);
    expect(fresh).toHaveBeenCalledWith('/table/22222222222222222222222222222222?invite=1');
  });
});
