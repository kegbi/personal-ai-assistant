import { cloneDeep } from 'es-toolkit/object';
import { isString } from 'es-toolkit/predicate';
import { trim } from 'es-toolkit/string';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonRecord = Record<string, JsonValue>;

/**
 * Creates a deep clone of the provided value ensuring nested references are copied.
 *
 * @param value Value to clone.
 * @returns A deep copy of the provided value.
 */
export const cloneValue = <T>(value: T): T => cloneDeep(value);

/**
 * Ensures the provided value is a plain object with string keys.
 *
 * @param candidate Value to evaluate.
 * @returns True when the value is a record.
 */
export const isRecord = (
  candidate: unknown,
): candidate is Record<string, unknown> =>
  typeof candidate === 'object' &&
  candidate !== null &&
  !Array.isArray(candidate);

/**
 * Reads a trimmed string value from a record when present.
 *
 * @param record Record that may contain the value.
 * @param key Property to lookup.
 * @returns Trimmed string or `undefined` when missing.
 */
export const extractTrimmedString = (
  record: Record<string, unknown>,
  key: string,
): string | undefined => {
  const raw = record[key];
  if (!isString(raw)) {
    return undefined;
  }

  const trimmed = trim(raw);
  return trimmed.length > 0 ? trimmed : undefined;
};
