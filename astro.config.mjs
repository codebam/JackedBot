import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import cloudflare from '@astrojs/cloudflare';

// Every page is server-rendered: the lobby must read D1 per request and the
// Telegram webhook must be a POST handler. The only client JavaScript is the
// Preact island on /table/[id].
export default defineConfig({
  output: 'server',
  prefetch: false,
  trailingSlash: 'ignore',

  // Identity comes from verified Telegram initData on every single request, so a
  // cookie session would be a second, weaker source of truth. Turning sessions
  // off also stops the adapter wiring a KV namespace for it.
  session: false,

  integrations: [preact()],

  // The adapter goes in `adapter`, NOT `integrations` — Astro unshifts it into
  // the integration list itself (see astro/dist/integrations/hooks.js), and
  // `output: 'server'` is rejected unless `config.adapter` is populated.
  adapter: cloudflare({
    // No Astro <Image> transforms in this app; avoids auto-provisioning an
    // Images binding that would have to exist before the first deploy works.
    imageService: 'passthrough',
    // Build-time prerendering (there is essentially none here) runs in Node so it
    // never needs runtime-only bindings during `astro build`. On-demand pages
    // still run in workerd, matching production.
    prerenderEnvironment: 'node',
  }),

  vite: {
    build: {
      // Un-minified worker: Cloudflare's structured errors and our own log lines
      // then point at real source lines instead of `t(<bundle>:1:4412)`.
      minify: false,
    },
  },

  devToolbar: { enabled: false },
  telemetry: false,
});
