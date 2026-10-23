import type { z } from 'zod';

/** Validate untrusted input. A failure throws a ZodError, which the error handler turns into a 400 VALIDATION problem. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  return schema.parse(data);
}

/** Query-string numbers arrive as strings. */
export const intParam = (v: unknown): number | undefined => {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
};
