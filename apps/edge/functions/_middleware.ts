import { handle, type BffEnv } from '../src/bff.js';

/** Runs on every request to the Pages project; `next()` serves the static Next.js export. */
export const onRequest = (ctx: { request: Request; env: BffEnv; next: () => Promise<Response> }): Promise<Response> =>
  handle(ctx.request, ctx.env, ctx.next);
