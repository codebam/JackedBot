// The Worker module under test. It exports the *real* Table class and the *real*
// relay helpers — the only thing it swaps for the production entrypoint is the
// Astro handler, which would drag build-time virtual modules into the test bundle.
import { Table } from '../../src/platform/table.do.ts';
import { isTableSocketRequest, relayTableSocket } from '../../src/platform/ws-relay.ts';

export { Table };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (isTableSocketRequest(request)) return relayTableSocket(request, env);
    return new Response('test worker', { status: 200 });
  },
} satisfies ExportedHandler<Env>;
