// Phase 3 — authentication. RFC 7807 (application/problem+json) error model.
// Every error the API returns — validation failures, auth failures, 404s, 500s —
// goes through here so clients see one consistent shape.

import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  /** field-level validation failures, when applicable */
  errors?: Array<{ field: string; message: string }>;
}

/** Throw these from route handlers / services; the error handler maps them. */
export class HttpProblem extends Error {
  readonly status: number;
  readonly title: string;
  readonly type: string;
  readonly errors?: Problem['errors'];

  constructor(
    status: number,
    title: string,
    detail?: string,
    opts?: { type?: string; errors?: Problem['errors'] },
  ) {
    super(detail ?? title);
    this.name = 'HttpProblem';
    this.status = status;
    this.title = title;
    this.type = opts?.type ?? 'about:blank';
    this.errors = opts?.errors;
  }
}

export const unauthorized = (detail = 'Authentication required.') =>
  new HttpProblem(401, 'Unauthorized', detail, {
    type: 'https://api.music-streaming.local/problems/unauthorized',
  });

export const forbidden = (detail = 'You do not have permission to do that.') =>
  new HttpProblem(403, 'Forbidden', detail, {
    type: 'https://api.music-streaming.local/problems/forbidden',
  });

export const notFound = (detail = 'The requested resource was not found.') =>
  new HttpProblem(404, 'Not Found', detail, {
    type: 'https://api.music-streaming.local/problems/not-found',
  });

export const badRequest = (detail: string) =>
  new HttpProblem(400, 'Bad Request', detail, {
    type: 'https://api.music-streaming.local/problems/bad-request',
  });

export const conflict = (detail: string) =>
  new HttpProblem(409, 'Conflict', detail, {
    type: 'https://api.music-streaming.local/problems/conflict',
  });

export const tooManyRequests = (detail = 'Too many requests. Slow down and try again.') =>
  new HttpProblem(429, 'Too Many Requests', detail, {
    type: 'https://api.music-streaming.local/problems/rate-limited',
  });

// Phase 14 — ingestion errors.
export const payloadTooLarge = (detail: string) =>
  new HttpProblem(413, 'Payload Too Large', detail, {
    type: 'https://api.music-streaming.local/problems/payload-too-large',
  });

export const unsupportedMediaType = (detail: string) =>
  new HttpProblem(415, 'Unsupported Media Type', detail, {
    type: 'https://api.music-streaming.local/problems/unsupported-media-type',
  });

export const unprocessableEntity = (detail: string) =>
  new HttpProblem(422, 'Unprocessable Entity', detail, {
    type: 'https://api.music-streaming.local/problems/unprocessable-entity',
  });

// Phase 18 — subscriptions. Distinct 403 for entitlement denial so clients
// can distinguish "no subscription" from generic permission failures and
// render locked UI. The title is the stable client contract.
export const subscriptionRequired = (detail: string) =>
  new HttpProblem(403, 'Subscription Required', detail, {
    type: 'https://api.music-streaming.local/problems/subscription-required',
  });

// Phase 19 — 503 for store integrations that are not configured (or store
// API outages). Failing closed: verification is impossible without the
// integration, so the client can retry after the operator configures it.
export const serviceUnavailable = (detail: string) =>
  new HttpProblem(503, 'Service Unavailable', detail, {
    type: 'https://api.music-streaming.local/problems/service-unavailable',
  });

function sendProblem(reply: FastifyReply, problem: Problem): FastifyReply {
  return reply.code(problem.status).type('application/problem+json').send(problem);
}

/** Fastify schema-validation failures -> 400 problem+json with field details. */
function validationProblem(err: FastifyError): Problem {
  const errors =
    err.validation?.map((v) => ({
      field: v.instancePath.replace(/^\//, '') || v.params?.missingProperty?.toString() || '(body)',
      message: v.message ?? 'invalid value',
    })) ?? [];
  return {
    type: 'https://api.music-streaming.local/problems/validation-error',
    title: 'Bad Request',
    status: 400,
    detail: 'The request body failed validation.',
    errors,
  };
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, _req, reply) => {
    // Thrown deliberately from handlers/services.
    if (err instanceof HttpProblem) {
      const { status, title, type, errors } = err;
      return sendProblem(reply, { status, title, type, detail: err.message, errors });
    }

    // @fastify/rate-limit signals 429s this way.
    if (err.statusCode === 429) {
      const p = tooManyRequests();
      return sendProblem(reply, { status: 429, title: p.title, type: p.type, detail: p.message });
    }

    // Request schema validation failures.
    if (err.validation) {
      return sendProblem(reply, validationProblem(err));
    }

    // Malformed JSON bodies.
    if (err.statusCode === 400) {
      return sendProblem(reply, {
        type: 'https://api.music-streaming.local/problems/validation-error',
        title: 'Bad Request',
        status: 400,
        detail: 'The request body is not valid JSON or is otherwise malformed.',
      });
    }

    // Anything else with a 4xx status from Fastify internals.
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return sendProblem(reply, {
        type: 'about:blank',
        title: 'Bad Request',
        status: err.statusCode,
        detail: err.message,
      });
    }

    // 500s: log the real error, return a generic problem (never leak internals).
    app.log.error(err);
    return sendProblem(reply, {
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      detail: 'Something went wrong. Try again later.',
    });
  });

  app.setNotFoundHandler((req, reply) => {
    sendProblem(reply, {
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: `No route matches ${req.method} ${req.raw.url}.`,
    });
  });
}

/**
 * Phase 4 — shared JSON Schema for RFC 7807 error responses, referenced from
 * route `response` schemas so the OpenAPI document describes error shapes.
 */
export const problemSchema = {
  type: 'object',
  properties: {
    type: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'integer' },
    detail: { type: 'string' },
    errors: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string' },
          message: { type: 'string' },
        },
      },
    },
  },
} as const;
