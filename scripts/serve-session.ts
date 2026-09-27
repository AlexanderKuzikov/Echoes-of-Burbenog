// Runs the session server. It is a separate entry point from the library on purpose: importing
// `src/server` must never start listening, because the E2E suite, the type check and any future tool
// all import it without asking for a port.
//
// The port comes from `--port`, then `PORT`, then the shared default in the protocol module — the same
// number the client falls back to, so the two halves of a local session cannot disagree about the
// address and fail to meet.

import { DEFAULT_SESSION_PORT } from '../src/protocol/index.ts';
import { createSessionServer } from '../src/server/index.ts';

const readPort = (argv: readonly string[]): number => {
  const flag = argv.indexOf('--port');
  if (flag >= 0) {
    const value = Number.parseInt(argv[flag + 1] ?? '', 10);
    if (Number.isInteger(value) && value > 0 && value < 65536) {
      return value;
    }
    throw new Error(`--port needs a port number, got ${String(argv[flag + 1])}`);
  }
  const fromEnv = Number.parseInt(process.env.PORT ?? '', 10);
  return Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv < 65536 ? fromEnv : DEFAULT_SESSION_PORT;
};

const host = process.env.SESSION_HOST ?? '127.0.0.1';
const session = createSessionServer({ port: readPort(process.argv.slice(2)), host, log: (line) => console.log(`[session] ${line}`) });

session.server.on('listening', () => {
  console.log(`[session] authoritative sessions on http://${host}:${session.port}`);
  console.log(`[session] handshake POST /api/rooms/<room>/handshake · stream GET /api/rooms/<room>/stream?client=<id> · commands POST /api/rooms/<room>/commands`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void session.close().then(() => {
      process.exit(0);
    });
  });
}
