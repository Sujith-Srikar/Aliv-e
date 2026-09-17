import { ZodError } from 'zod';
import { logger } from '../../shared/logger';
import { MonitorLimitError } from '../../shared/monitor-limit';
import { SsrfError } from '../../shared/ssrf';

export class HttpError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    status,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

export function ok(data: unknown): Response {
  return json({ data });
}

export function created(data: unknown): Response {
  return json({ data }, 201);
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

export function fail(code: string, message: string, status = 400): Response {
  return json({ error: { code, message } }, status);
}

export async function readJson(
  request: Request,
  maxBytes = 16_384,
): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > maxBytes) {
    throw new HttpError('BODY_TOO_LARGE', 'request body too large', 413);
  }
  if (text.trim().length === 0) {
    throw new HttpError('EMPTY_BODY', 'request body is required', 400);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError('BAD_JSON', 'request body must be valid JSON', 400);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError('BAD_JSON', 'request body must be a JSON object', 400);
  }
  return parsed as Record<string, unknown>;
}

function isPostgrestError(e: unknown): e is { code?: string; message?: string } {
  return typeof e === 'object' && e !== null && ('code' in e || 'message' in e);
}

function checkConstraintName(e: { message?: string }): string | null {
  return /violates check constraint "([^"]+)"/.exec(e.message ?? '')?.[1] ?? null;
}

function checkViolationMessage(e: { message?: string }): string {
  switch (checkConstraintName(e)) {
    case 'monitors_interval_minutes_check':
      return 'intervalMinutes must be one of 10, 14, 15, 20, 30, 45, 60';
    case 'monitors_timeout_seconds_check':
      return 'timeoutSeconds must be one of 1, 5, 10, 15, 20, 30, 45, 60';
    case 'monitors_timeout_lt_interval_check':
      return 'timeoutSeconds must be less than the check interval';
    default:
      return 'invalid monitor configuration';
  }
}

export function handleError(e: unknown): Response {
  if (e instanceof HttpError) {
    return fail(e.code, e.message, e.status);
  }
  if (e instanceof ZodError) {
    // User input problem, not a bug: warn (not error) but keep the issues —
    // they carry path + received value/type, which is what you grep for.
    logger.warn('validation error', e.issues);
    return fail('VALIDATION_ERROR', e.issues[0]?.message ?? 'invalid input', 400);
  }
  if (e instanceof SsrfError) {
    return fail('SSRF_BLOCKED', e.message, 400);
  }
  if (e instanceof MonitorLimitError) {
    return fail('LIMIT_EXCEEDED', e.message, 429);
  }
  if (isPostgrestError(e) && e.code === '23505') {
    return fail('CONFLICT', 'a resource with these details already exists', 409);
  }
  if (isPostgrestError(e) && e.code === '23514') {
    // App validation passed but the database refused the row: either a
    // single-field PATCH breaking a cross-field CHECK, or DB/app drift
    // (migrations not applied). Always log at error level with the full
    // constraint + failing row, and tag the client message with the
    // constraint name so it can't be mistaken for the Zod message.
    logger.error('database check violation', e);
    const constraint = checkConstraintName(e);
    const message = checkViolationMessage(e);
    return fail(
      'VALIDATION_ERROR',
      constraint ? `${message} (database: ${constraint})` : message,
      400,
    );
  }
  // inserts that race past the app-level count check hit the DB trigger
  // (monitors_check_user_cap), which raises P0001 — surface as 429, not 500.
  if (
    isPostgrestError(e) &&
    e.code === 'P0001' &&
    (e.message ?? '').includes('maximum number of monitors')
  ) {
    return fail('LIMIT_EXCEEDED', e.message as string, 429);
  }
  logger.error('api error', e);
  return fail('INTERNAL', 'internal server error', 500);
}
