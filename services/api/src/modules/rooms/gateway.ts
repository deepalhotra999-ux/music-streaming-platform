// Phase 28 — WebSocket gateway for synchronized listening rooms.
//
// Transport: `GET /v1/rooms/ws?token=<access JWT>` (WebSocket clients cannot
// set an Authorization header, so the bearer token travels as a query
// parameter — the same access JWT issued by POST /v1/auth/login, verified
// with the same jose parameters as the HTTP `authenticate` guard). The token
// is stripped from the request URL in the auth hook so it never lands in
// request logs.
//
// Protocol (JSON messages):
//   Client -> server:
//     { "type": "ping", "clientTime": 123 }                    -> clock sync
//     { "type": "room.join", "roomId": "<uuid>" }              -> subscribe
//     { "type": "room.leave", "roomId": "<uuid>" }             -> unsubscribe
//     { "type": "room.resync", "roomId": "<uuid>" }            -> fresh state
//     { "type": "room.command", "roomId": "<uuid>",
//       "command": "play"|"pause"|"seek"|"next"|"previous"|"queue",
//       "expectedRevision": 12, "positionMs": 1234,             // play/pause/seek
//       "trackIds": ["<uuid>", ...], "queueIndex": 0 }         // queue
//   Server -> client:
//     { "type": "pong", "clientTime": 123, "serverTime": "<iso>" }
//     { "type": "room.state", "state": { ...RoomStateDto } }
//     { "type": "room.event", "roomId": "<uuid>",
//       "event": "member_joined"|"member_left"|"room_ended", "userId": "<uuid>" }
//     { "type": "error", "code": "<code>", "message": "<msg>",
//       "roomId": "<uuid>", "currentRevision": 12 }
//
// Authorization is never left to the socket layer: every join and every
// command re-validates membership, role, room status, and track
// authorization against the database. Room state carries track IDs and
// display metadata only — never playback tokens, never audio URLs.

import * as jose from 'jose';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { Config } from '../../config.js';
import { HttpProblem, unauthorized } from '../../http/errors.js';
import { metrics } from '../../http/metrics.js';
import { prisma } from '../../db.js';
import {
  applyRoomCommand,
  buildRoomState,
  type RoomCommand,
  type RoomStateDto,
} from './service.js';
import {
  broadcastToRoom,
  getClient,
  joinRoomChannel,
  leaveAllRooms,
  leaveRoomChannel,
  registerClient,
  roomSubscriberCount,
} from './hub.js';

const WS_MAX_COMMANDS_PER_WINDOW = 30;
const WS_COMMAND_WINDOW_MS = 10_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CommandName = 'play' | 'pause' | 'seek' | 'next' | 'previous' | 'queue';

interface ClientMessage {
  type: string;
  roomId?: unknown;
  clientTime?: unknown;
  command?: unknown;
  expectedRevision?: unknown;
  positionMs?: unknown;
  trackIds?: unknown;
  queueIndex?: unknown;
}

/** Verify the raw access token exactly like the HTTP `authenticate` guard. */
async function verifyAccessToken(token: string, config: Config) {
  const secret = new TextEncoder().encode(config.jwtSecret);
  const { payload } = await jose.jwtVerify(token, secret, {
    issuer: config.jwtIssuer,
    audience: config.jwtAudience,
  });
  if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
    throw unauthorized('Invalid or expired access token.');
  }
  return {
    id: payload.sub,
    email: payload.email,
    role: typeof payload.role === 'string' ? payload.role : 'LISTENER',
  };
}

/**
 * Authenticate the WebSocket upgrade from the `token` query parameter.
 * The token is removed from the request URL before anything is logged so
 * authentication tokens never appear in request logs.
 */
async function authenticateWsUpgrade(req: FastifyRequest, _reply: FastifyReply, config: Config) {
  const rawUrl = req.raw.url ?? '';
  const qIndex = rawUrl.indexOf('?');
  const params = new URLSearchParams(qIndex >= 0 ? rawUrl.slice(qIndex + 1) : '');
  const token = params.get('token');
  // Strip the token from the URL first: request logs serialize req.url.
  params.delete('token');
  const cleanQuery = params.toString();
  req.raw.url =
    (qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl) + (cleanQuery ? `?${cleanQuery}` : '');
  if (!token) {
    throw unauthorized('Missing token query parameter. Use "/v1/rooms/ws?token=<access JWT>".');
  }
  let authUser;
  try {
    authUser = await verifyAccessToken(token, config);
  } catch {
    // Deliberately vague, mirroring the HTTP guard.
    throw unauthorized('Invalid or expired access token.');
  }
  req.authUser = authUser;
}

function send(socket: WebSocket, message: unknown): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function sendError(
  socket: WebSocket,
  code: string,
  message: string,
  roomId?: string,
  currentRevision?: number,
): void {
  send(socket, {
    type: 'error',
    code,
    message,
    ...(roomId !== undefined ? { roomId } : {}),
    ...(currentRevision !== undefined ? { currentRevision } : {}),
  });
}

function sendState(socket: WebSocket, state: RoomStateDto): void {
  send(socket, { type: 'room.state', state });
}

/** Map an HttpProblem from the service layer to a WS error code. */
function problemToCode(problem: HttpProblem): string {
  switch (problem.status) {
    case 400:
      return 'invalid_command';
    case 401:
      return 'unauthorized';
    case 403:
      return problem.title === 'Subscription Required' ? 'entitlement_required' : 'host_only';
    case 404:
      return 'room_not_found';
    case 409:
      return 'stale_revision';
    case 410:
      return 'room_ended';
    case 429:
      return 'rate_limited';
    default:
      return 'internal_error';
  }
}

function parseClientMessage(raw: Buffer | string): ClientMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString());
  } catch {
    throw new HttpProblem(400, 'Bad Request', 'Message is not valid JSON.', {
      type: 'https://api.music-streaming.local/problems/bad-request',
    });
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { type: unknown }).type !== 'string'
  ) {
    throw new HttpProblem(
      400,
      'Bad Request',
      'Message must be a JSON object with a string "type".',
      {
        type: 'https://api.music-streaming.local/problems/bad-request',
      },
    );
  }
  return parsed as ClientMessage;
}

function requireRoomId(msg: ClientMessage): string {
  if (typeof msg.roomId !== 'string' || !UUID_RE.test(msg.roomId)) {
    throw new HttpProblem(400, 'Bad Request', '"roomId" must be a UUID.', {
      type: 'https://api.music-streaming.local/problems/bad-request',
    });
  }
  return msg.roomId;
}

function toRoomCommand(msg: ClientMessage): { command: RoomCommand; expectedRevision: number } {
  if (typeof msg.command !== 'string') {
    throw new HttpProblem(400, 'Bad Request', '"command" must be a string.', {
      type: 'https://api.music-streaming.local/problems/bad-request',
    });
  }
  const name = msg.command as CommandName;
  if (
    typeof msg.expectedRevision !== 'number' ||
    !Number.isInteger(msg.expectedRevision) ||
    msg.expectedRevision < 0
  ) {
    throw new HttpProblem(
      400,
      'Bad Request',
      '"expectedRevision" must be a non-negative integer.',
      {
        type: 'https://api.music-streaming.local/problems/bad-request',
      },
    );
  }
  const expectedRevision = msg.expectedRevision;
  switch (name) {
    case 'play':
    case 'pause':
    case 'seek': {
      if (typeof msg.positionMs !== 'number') {
        throw new HttpProblem(400, 'Bad Request', `"${name}" requires a numeric "positionMs".`, {
          type: 'https://api.music-streaming.local/problems/bad-request',
        });
      }
      return { command: { type: name, positionMs: msg.positionMs }, expectedRevision };
    }
    case 'next':
    case 'previous':
      return { command: { type: name }, expectedRevision };
    case 'queue': {
      if (
        !Array.isArray(msg.trackIds) ||
        msg.trackIds.length === 0 ||
        msg.trackIds.length > 200 ||
        !msg.trackIds.every((t): t is string => typeof t === 'string' && UUID_RE.test(t))
      ) {
        throw new HttpProblem(
          400,
          'Bad Request',
          '"trackIds" must be a non-empty array of UUIDs (max 200).',
          {
            type: 'https://api.music-streaming.local/problems/bad-request',
          },
        );
      }
      let queueIndex: number | undefined;
      if (msg.queueIndex !== undefined) {
        if (
          typeof msg.queueIndex !== 'number' ||
          !Number.isInteger(msg.queueIndex) ||
          msg.queueIndex < 0
        ) {
          throw new HttpProblem(
            400,
            'Bad Request',
            '"queueIndex" must be a non-negative integer.',
            {
              type: 'https://api.music-streaming.local/problems/bad-request',
            },
          );
        }
        queueIndex = msg.queueIndex;
      }
      return { command: { type: 'queue', trackIds: msg.trackIds, queueIndex }, expectedRevision };
    }
    default:
      throw new HttpProblem(400, 'Bad Request', `Unknown command "${msg.command}".`, {
        type: 'https://api.music-streaming.local/problems/bad-request',
      });
  }
}

/** Per-socket sliding-window throttle for host commands. */
function checkCommandThrottle(socket: WebSocket): boolean {
  const client = getClient(socket);
  if (!client) return false;
  const now = Date.now();
  client.commandTimestamps = client.commandTimestamps.filter((t) => now - t < WS_COMMAND_WINDOW_MS);
  if (client.commandTimestamps.length >= WS_MAX_COMMANDS_PER_WINDOW) {
    return false;
  }
  client.commandTimestamps.push(now);
  return true;
}

export async function roomsGateway(app: FastifyInstance, config: Config): Promise<void> {
  app.get(
    '/v1/rooms/ws',
    {
      websocket: true,
      preHandler: [
        async (req: FastifyRequest, reply: FastifyReply) => {
          await authenticateWsUpgrade(req, reply, config);
        },
      ],
      // Bound the upgrade rate like the rest of the API surface.
      config: { rateLimit: { max: config.rateLimits.api, timeWindow: config.rateLimits.windowMs } },
    },
    (socket: WebSocket, req: FastifyRequest) => {
      const userId = req.authUser!.id;

      // Attach handlers synchronously (per @fastify/websocket guidance);
      // auth already happened in preHandler, so the client record can be
      // registered immediately.
      const client = registerClient(socket, userId);
      app.log.info({ roomEvent: 'ws.connected', userId });
      // Phase 32 — observability: track WebSocket connection counts.
      metrics.wsConnected();

      // Serialize message processing per socket so commands from one
      // connection apply in send order; cross-connection ordering is
      // enforced by the revision compare-and-swap in the service.
      let queue: Promise<void> = Promise.resolve();
      socket.on('message', (raw: Buffer) => {
        queue = queue
          .then(() => handleMessage(app, socket, client, raw))
          .catch((err: unknown) => {
            app.log.error({ roomEvent: 'ws.message_failed', userId, err });
            sendError(socket, 'internal_error', 'Failed to process the message.');
          });
      });

      socket.on('close', () => {
        leaveAllRooms(socket);
        metrics.wsDisconnected();
        app.log.info({ roomEvent: 'ws.disconnected', userId });
      });

      socket.on('error', (err: Error) => {
        metrics.wsError();
        app.log.warn({ roomEvent: 'ws.socket_error', userId, err: err.message });
      });
    },
  );
}

async function handleMessage(
  app: FastifyInstance,
  socket: WebSocket,
  client: { userId: string; rooms: Set<string> },
  raw: Buffer,
): Promise<void> {
  const userId = client.userId;
  let msg: ClientMessage;
  try {
    msg = parseClientMessage(raw);
  } catch (err) {
    const code = err instanceof HttpProblem ? problemToCode(err) : 'invalid_command';
    sendError(socket, code, err instanceof Error ? err.message : 'Invalid message.');
    return;
  }

  try {
    switch (msg.type) {
      case 'ping': {
        const clientTime = typeof msg.clientTime === 'number' ? msg.clientTime : null;
        send(socket, {
          type: 'pong',
          clientTime,
          serverTime: new Date().toISOString(),
        });
        return;
      }
      case 'room.join': {
        const roomId = requireRoomId(msg);
        // buildRoomState re-validates membership server-side; non-members
        // get an existence-hiding 404 mapped to room_not_found. This is a
        // socket subscription, not a membership change: member_joined is
        // broadcast by the HTTP join handler, so reconnects stay silent.
        const state = await buildRoomStateForSocket(roomId, userId);
        joinRoomChannel(roomId, socket);
        app.log.info({
          roomEvent: 'room.ws_joined',
          roomId,
          userId,
          revision: state.revision,
          subscribers: roomSubscriberCount(roomId),
        });
        sendState(socket, state);
        return;
      }
      case 'room.leave': {
        const roomId = requireRoomId(msg);
        leaveRoomChannel(roomId, socket);
        app.log.info({ roomEvent: 'room.ws_left', roomId, userId });
        return;
      }
      case 'room.resync': {
        const roomId = requireRoomId(msg);
        const state = await buildRoomStateForSocket(roomId, userId);
        app.log.info({ roomEvent: 'room.resync', roomId, userId, revision: state.revision });
        sendState(socket, state);
        return;
      }
      case 'room.command': {
        const roomId = requireRoomId(msg);
        if (!checkCommandThrottle(socket)) {
          app.log.warn({ roomEvent: 'room.command_throttled', roomId, userId });
          sendError(socket, 'rate_limited', 'Too many commands. Slow down and try again.', roomId);
          return;
        }
        const { command, expectedRevision } = toRoomCommand(msg);
        const startedAt = Date.now();
        const state = await applyRoomCommand(roomId, userId, command, expectedRevision);
        app.log.info({
          roomEvent: 'room.command',
          roomId,
          userId,
          command: command.type,
          revision: state.revision,
          latencyMs: Date.now() - startedAt,
        });
        broadcastToRoom(roomId, { type: 'room.state', state });
        return;
      }
      default:
        sendError(socket, 'invalid_command', `Unknown message type "${msg.type}".`);
    }
  } catch (err) {
    if (err instanceof HttpProblem) {
      const code = problemToCode(err);
      const roomId = typeof msg.roomId === 'string' ? msg.roomId : undefined;
      let currentRevision: number | undefined;
      if (code === 'stale_revision' && roomId) {
        // Hand the client the authoritative revision so it can resync.
        try {
          const fresh = await buildRoomStateForSocket(roomId, userId);
          currentRevision = fresh.revision;
          sendState(socket, fresh);
        } catch {
          // Membership may have lapsed; the error alone is enough.
        }
      }
      app.log.info({ roomEvent: 'room.command_rejected', roomId, userId, code });
      sendError(socket, code, err.message, roomId, currentRevision);
      return;
    }
    throw err;
  }
}

/** Membership-checked state fetch shared by join/resync/command paths. */
async function buildRoomStateForSocket(roomId: string, userId: string): Promise<RoomStateDto> {
  return buildRoomState(prisma, roomId, userId);
}

/**
 * Broadcast a room event from HTTP lifecycle handlers (leave/end), which
 * run outside the gateway. Safe to call when no sockets are subscribed.
 */
export function broadcastRoomEvent(
  roomId: string,
  event: 'member_joined' | 'member_left' | 'room_ended',
  userId?: string,
): void {
  broadcastToRoom(roomId, { type: 'room.event', roomId, event, ...(userId ? { userId } : {}) });
}
