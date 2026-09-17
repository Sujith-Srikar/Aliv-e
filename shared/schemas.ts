import { z } from 'zod';

export const ALLOWED_INTERVALS = [10, 14, 15, 20, 30, 45, 60] as const;
export const ALLOWED_TIMEOUTS = [1, 5, 10, 15, 20, 30, 45, 60] as const;

const USERNAME_RE = /^[a-z0-9_-]{3,10}$/;

const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(USERNAME_RE, 'username must be 3-10 chars (a-z, 0-9, _ or -)');

const name = z.string().trim().min(1, 'name must be 1-80 chars').max(80, 'name must be 1-80 chars');

// z.url() accepts any scheme (e.g. ftp:); narrow to http(s) to match
// assertSafeUrl and the dashboard client-side check.
const url = z
  .url('url must be a valid http(s) URL')
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  }, 'url must be a valid http(s) URL');

function timeoutBelowInterval(data: { intervalMinutes?: number; timeoutSeconds?: number }): boolean {
  if (data.intervalMinutes === undefined || data.timeoutSeconds === undefined) return true;
  return data.timeoutSeconds < data.intervalMinutes * 60;
}

const timeoutIntervalMessage = 'timeoutSeconds must be less than the check interval';

function allowedNumber(values: readonly number[], message: string) {
  return z.union(
    values.map((n) => z.literal(n)),
    { error: message },
  );
}

export const CreateMonitorSchema = z
  .object({
    username,
    name,
    url,
    intervalMinutes: allowedNumber(
      ALLOWED_INTERVALS,
      'intervalMinutes must be one of 10, 14, 15, 20, 30, 45, 60',
    ),
    timeoutSeconds: allowedNumber(
      ALLOWED_TIMEOUTS,
      'timeoutSeconds must be one of 1, 5, 10, 15, 20, 30, 45, 60',
    ),
  })
  .refine(timeoutBelowInterval, { message: timeoutIntervalMessage, path: ['timeoutSeconds'] });

export const UpdateMonitorSchema = z
  .object({
    name: name.optional(),
    url: url.optional(),
    intervalMinutes: allowedNumber(
      ALLOWED_INTERVALS,
      'intervalMinutes must be one of 10, 14, 15, 20, 30, 45, 60',
    ).optional(),
    timeoutSeconds: allowedNumber(
      ALLOWED_TIMEOUTS,
      'timeoutSeconds must be one of 1, 5, 10, 15, 20, 30, 45, 60',
    ).optional(),
    isPaused: z.boolean().optional(),
  })
  // Only fires when both fields are present in the PATCH body; single-field
  // changes are checked against the stored row by the DB constraint
  // (monitors_timeout_lt_interval_check), surfaced as a 400 by handleError.
  .refine(timeoutBelowInterval, { message: timeoutIntervalMessage, path: ['timeoutSeconds'] });

export const ListMonitorsQuerySchema = z.object({
  username,
});

export type CreateMonitorInput = z.infer<typeof CreateMonitorSchema>;
export type UpdateMonitorInput = z.infer<typeof UpdateMonitorSchema>;
