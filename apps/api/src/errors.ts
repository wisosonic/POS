import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

/** RFC 7807 problem details with a stable `code` (list in docs/06-api-spec.md). */
export type Problem = {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  errors?: { path: string; message: string }[];
  [extra: string]: unknown;
};

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(detail);
  }
}

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  423: 'Locked',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
};

export const E = {
  validation: (detail = 'Invalid request', errors?: Problem['errors']) => new AppError(400, 'VALIDATION', detail, errors ? { errors } : {}),
  unauthenticated: (detail = 'Authentication required') => new AppError(401, 'UNAUTHENTICATED', detail),
  forbidden: (detail = 'You do not have permission to do this') => new AppError(403, 'FORBIDDEN', detail),
  notFound: (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`),
  conflict: (code: string, detail: string) => new AppError(409, code, detail),
  unprocessable: (code: string, detail: string) => new AppError(422, code, detail),
};

export function problem(status: number, code: string, detail: string, extra: Record<string, unknown> = {}): Problem {
  return { type: 'about:blank', title: TITLES[status] ?? 'Error', status, detail, code, ...extra };
}

function zodErrors(err: ZodError): NonNullable<Problem['errors']> {
  return err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/** Fastify error handler: every failure leaves the API as a problem+json body. Internal details never leak. */
export function errorHandler(err: FastifyError | AppError | ZodError, req: FastifyRequest, reply: FastifyReply) {
  let body: Problem;
  if (err instanceof AppError) {
    body = problem(err.status, err.code, err.message, err.extra);
    if (typeof err.extra.retryAfterSeconds === 'number') void reply.header('Retry-After', String(err.extra.retryAfterSeconds));
  } else if (err instanceof ZodError) {
    body = problem(400, 'VALIDATION', 'Invalid request', { errors: zodErrors(err) });
  } else if (typeof (err as { code?: unknown }).code === 'string' && (err as { code: string }).code.startsWith('SQLITE_CONSTRAINT')) {
    // A constraint the database enforces. Translate it, and never leak SQL or table names to the client.
    const code = (err as { code: string }).code;
    if (code.includes('FOREIGN')) body = problem(422, 'INVALID_REFERENCE', 'A referenced record does not exist');
    else if (code.includes('UNIQUE') || code.includes('PRIMARYKEY')) body = problem(409, 'CONFLICT', 'That record already exists');
    else if (code.includes('TRIGGER') && /REGISTER_CLOSED/.test(err.message))
      body = problem(409, 'REGISTER_CLOSED', 'The register is closed');
    else if (code.includes('TRIGGER') && /DUPLICATE_BARCODE/.test(err.message))
      body = problem(409, 'DUPLICATE_BARCODE', 'Another active product already has this barcode');
    else {
      req.log.warn({ err }, 'database constraint violation');
      body = problem(400, 'VALIDATION', 'The data violates a rule');
    }
  } else {
    const fe = err as FastifyError;
    const status = typeof fe.statusCode === 'number' && fe.statusCode >= 400 && fe.statusCode < 500 ? fe.statusCode : 500;
    if (status === 429) body = problem(429, 'RATE_LIMITED', 'Too many requests. Try again shortly.');
    else if (status === 413) body = problem(413, 'PAYLOAD_TOO_LARGE', 'That is too large to accept');
    else if (status === 415) body = problem(415, 'UNSUPPORTED_MEDIA_TYPE', 'That kind of content is not accepted here');
    else if (status >= 500) {
      req.log.error({ err }, 'unhandled error');
      body = problem(500, 'INTERNAL', 'Something went wrong');
    } else body = problem(status, status === 404 ? 'NOT_FOUND' : 'VALIDATION', status === 404 ? 'Resource not found' : 'Invalid request');
  }
  void reply.status(body.status).type('application/problem+json').send(body);
}

export function notFoundHandler(_req: FastifyRequest, reply: FastifyReply) {
  void reply
    .status(404)
    .type('application/problem+json')
    .send(problem(404, 'NOT_FOUND', 'Resource not found'));
}
