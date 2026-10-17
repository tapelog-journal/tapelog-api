/** Cloudflare Workers entry. Config comes from env vars / secrets: PAY_TO (required), NETWORK, FACILITATOR_URL. */
import { createApp } from "./app";

export interface Env { PAY_TO?: string; NETWORK?: string; FACILITATOR_URL?: string; }

let cached: { key: string; app: ReturnType<typeof createApp> } | null = null;

export default {
  fetch(req: Request, env: Env, ctx: unknown) {
    const key = [env.PAY_TO, env.NETWORK, env.FACILITATOR_URL].join("|");
    if (!cached || cached.key !== key) {
      cached = { key, app: createApp({ payTo: env.PAY_TO ?? "", network: env.NETWORK, facilitatorUrl: env.FACILITATOR_URL }) };
    }
    return cached.app.fetch(req, env, ctx as any);
  },
};
