// SPDX-License-Identifier: MIT
// Boot sequence: bind an ephemeral port, report it to the env service, then
// long-poll /done and exit cleanly when the trial ends.

import { createForgeServer } from './app.ts';
import { Forge } from './core.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

async function register(port: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.ok) return;
    } catch {
      // env service not up yet; retry briefly
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('env register failed');
}

async function waitForDone(): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`);
      if (response.ok) {
        const payload = (await response.json()) as { done?: boolean };
        if (payload.done === true) return;
      }
    } catch {
      // transient; keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

const server = createForgeServer(new Forge());
await new Promise<void>((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve());
});
const address = server.address();
if (address === null || typeof address === 'string') {
  throw new Error('server has no bound port');
}
await register(address.port);
await waitForDone();
await new Promise<void>((resolve) => {
  server.close(() => resolve());
});
process.exit(0);
