// The transport. One `node:http` server, no dependencies: snapshots and events go out as Server-Sent
// Events, commands come in as POST, and the handshake is a plain JSON exchange that both sides can
// refuse and both sides can read.
//
// SSE was chosen over WebSocket because Node has no WebSocket server to import and hand-writing the
// handshake of a binary protocol is how two implementations of everything begin. Commands are rare
// and the tick belongs to the room, so one outbound stream plus one inbound endpoint is the whole of
// what this phase needs. The cost and the `ws` alternative are named in `docs/DECISIONS.md`.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { DEFAULT_SESSION_PORT, SESSION_REFUSAL_TEXT, isRoomName, readCommandRequest } from '../protocol/index.ts';
import type { CommandAnswer, SessionFrame } from '../protocol/index.ts';
import { SessionRoom } from './room.ts';

// A command is a pad id and a tower id, so a body past this is not a body worth parsing. The cap is a
// trust boundary rather than a tuning knob.
const MAX_BODY_BYTES = 8 * 1024;

const json = (response: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
};

// Reads a body up to the cap and gives up on it rather than buffering past it. An oversized request is
// answered instead of being ignored, so a client that sends one is told why rather than left waiting
// for a reply that was never going to be small.
const readBody = (request: IncomingMessage): Promise<string | null> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;
    request.on('data', (chunk: Buffer) => {
      if (refused) {
        return;
      }
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        refused = true;
        chunks.length = 0;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!refused) {
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    request.on('error', () => {
      resolve(null);
    });
  });

// The client is served from the Vite origin and the room from its own port, so every answer carries
// what a cross-origin read needs. `*` is honest here and only here: there are no cookies, no
// credentials and no accounts, so there is nothing for a permissive origin to reach that the origin
// itself is not already entitled to. A build with identity on top of this narrows it.
const withCors = (response: ServerResponse): void => {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  response.setHeader('access-control-allow-headers', 'content-type');
  response.setHeader('access-control-max-age', '600');
};

const refusal = (reason: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  accepted: false,
  reason,
  text: SESSION_REFUSAL_TEXT[reason] ?? reason,
  ...extra,
});

export type SessionServer = {
  server: Server;
  port: number;
  close: () => Promise<void>;
};

export const createSessionServer = (
  options: { port?: number; host?: string; log?: (line: string) => void } = {},
): SessionServer => {
  const rooms = new Map<string, SessionRoom>();
  const streams = new Set<ServerResponse>();
  const log = options.log ?? ((): void => undefined);
  let nextClientId = 0;

  const roomFor = (roomId: string): SessionRoom => {
    const existing = rooms.get(roomId);
    if (existing) {
      return existing;
    }
    const created = new SessionRoom(roomId);
    rooms.set(roomId, created);
    log(`room ${roomId}: created on protocol v${created.versions.protocolVersion}`);
    return created;
  };

  const handleHandshake = async (roomId: string, request: IncomingMessage, response: ServerResponse) => {
    const raw = await readBody(request);
    if (raw === null) {
      json(response, 413, refusal('request-too-large'));
      return;
    }
    let declared: unknown;
    try {
      declared = JSON.parse(raw);
    } catch {
      json(response, 400, refusal('handshake-shape', { found: 'not JSON' }));
      return;
    }
    const room = roomFor(roomId);
    nextClientId += 1;
    const admission = room.admit(declared, `c${nextClientId}`);
    if (!admission.accepted) {
      json(response, 409, admission.refusal);
      return;
    }
    log(`room ${roomId}: client ${admission.clientId} admitted at protocol v${room.versions.protocolVersion}`);
    json(response, 200, {
      accepted: true,
      roomId,
      clientId: admission.clientId,
      tickRate: room.tickRate,
      versions: room.versions,
    });
  };

  const handleStream = (roomId: string, url: URL, request: IncomingMessage, response: ServerResponse) => {
    const room = rooms.get(roomId);
    const clientId = url.searchParams.get('client') ?? '';
    if (!room || !room.has(clientId)) {
      // Refused before a single byte of the stream is written: a stream the room does not recognise has
      // no state to start from, and a client that had one would only ever be shown a fiction.
      json(response, 404, refusal('unknown-client'));
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    const send = (frame: SessionFrame): void => {
      response.write(`data: ${JSON.stringify(frame)}\n\n`);
    };
    streams.add(response);
    if (!room.attach(clientId, send)) {
      // A second stream for a client that already has one. The headers are out, so the answer is an
      // empty stream rather than a status code that can no longer be sent.
      response.end();
      return;
    }
    log(`room ${roomId}: client ${clientId} attached, ${room.playerCount} connected`);
    const close = () => {
      streams.delete(response);
      room.detach(clientId);
      log(`room ${roomId}: client ${clientId} detached, ${room.playerCount} connected`);
    };
    request.on('close', close);
    request.on('error', close);
  };

  const handleCommand = async (roomId: string, request: IncomingMessage, response: ServerResponse) => {
    const raw = await readBody(request);
    if (raw === null) {
      json(response, 413, refusal('request-too-large'));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      json(response, 400, refusal('command-shape', { found: 'not JSON' }));
      return;
    }
    const room = rooms.get(roomId);
    const commandRequest = readCommandRequest(parsed);
    if (!room || !commandRequest) {
      json(response, 400, refusal('command-shape', { found: 'not a command this build reads' }));
      return;
    }
    const answer: CommandAnswer | null = room.dispatch(commandRequest.clientId, commandRequest.command);
    if (answer === null) {
      json(response, 404, refusal('unknown-client'));
      return;
    }
    json(response, 200, answer);
  };

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    withCors(response);
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    const segments = url.pathname.split('/').filter((part) => part.length > 0);

    if (request.method === 'GET' && url.pathname === '/api/health') {
      json(response, 200, {
        ok: true,
        rooms: Array.from(rooms.values(), (room) => ({
          roomId: room.id,
          players: room.playerCount,
          tick: room.tick,
          status: room.status,
          commands: room.commandCount,
          versions: room.versions,
        })),
      });
      return;
    }
    if (segments[0] !== 'api' || segments[1] !== 'rooms' || segments.length !== 4) {
      json(response, 404, refusal('unknown-room', { path: url.pathname }));
      return;
    }
    const roomId = segments[2] ?? '';
    const action = segments[3] ?? '';
    if (!isRoomName(roomId)) {
      json(response, 400, refusal('unknown-room', { found: roomId }));
      return;
    }
    if (request.method === 'POST' && action === 'handshake') {
      await handleHandshake(roomId, request, response);
      return;
    }
    if (request.method === 'GET' && action === 'stream') {
      handleStream(roomId, url, request, response);
      return;
    }
    if (request.method === 'POST' && action === 'commands') {
      await handleCommand(roomId, request, response);
      return;
    }
    json(response, 404, refusal('unknown-room', { path: url.pathname }));
  };

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (response.headersSent) {
        response.end();
        return;
      }
      json(response, 500, refusal('request-too-large', { found: 'the request could not be handled' }));
    });
  });

  const port = options.port ?? DEFAULT_SESSION_PORT;
  server.listen(port, options.host ?? '127.0.0.1');

  return {
    server,
    get port(): number {
      const address = server.address();
      return typeof address === 'object' && address !== null ? address.port : port;
    },
    close: (): Promise<void> =>
      new Promise((resolve) => {
        for (const room of rooms.values()) {
          room.shutdown();
        }
        for (const stream of streams) {
          stream.end();
        }
        streams.clear();
        server.close(() => {
          resolve();
        });
      }),
  };
};
