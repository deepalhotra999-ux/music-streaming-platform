// Phase 4 — shared pagination. Every list endpoint speaks the same dialect:
//
//   GET /v1/artists?page=2&limit=20
//   {
//     "data": [ ... ],
//     "pagination": { "page": 2, "limit": 20, "total": 87, "totalPages": 5 }
//   }
//
// Query params arrive as strings (Fastify's default ajv config does not coerce
// querystring scalars), so the schema validates the string form and
// `parsePagination` converts. Defaults: page 1, limit 20, limit capped at 100.

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export const paginationQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    page: { type: 'string', pattern: '^[1-9][0-9]*$' },
    limit: { type: 'string', pattern: '^[1-9][0-9]*$' },
  },
} as const;

export interface PaginationQuery {
  page?: string;
  limit?: string;
}

export interface Pagination {
  page: number;
  limit: number;
  skip: number;
}

export function parsePagination(query: PaginationQuery): Pagination {
  const page = query.page === undefined ? DEFAULT_PAGE : Number.parseInt(query.page, 10);
  const rawLimit = query.limit === undefined ? DEFAULT_LIMIT : Number.parseInt(query.limit, 10);
  const limit = Math.min(rawLimit, MAX_LIMIT);
  return { page, limit, skip: (page - 1) * limit };
}

export interface PageEnvelope<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export function pageEnvelope<T>(data: T[], total: number, p: Pagination): PageEnvelope<T> {
  return {
    data,
    pagination: {
      page: p.page,
      limit: p.limit,
      total,
      totalPages: Math.ceil(total / p.limit),
    },
  };
}

/** Wraps an item schema in the standard `{ data, pagination }` envelope. */
export function pageOf(itemSchema: unknown) {
  return {
    type: 'object',
    required: ['data', 'pagination'],
    properties: {
      data: { type: 'array', items: itemSchema },
      pagination: {
        type: 'object',
        required: ['page', 'limit', 'total', 'totalPages'],
        properties: {
          page: { type: 'integer', minimum: 1 },
          limit: { type: 'integer', minimum: 1 },
          total: { type: 'integer', minimum: 0 },
          totalPages: { type: 'integer', minimum: 0 },
        },
      },
    },
  } as const;
}

export const paginationEnvelopeSchema = (itemSchema: unknown) => pageOf(itemSchema);
