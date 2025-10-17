const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toStringOrUndefined = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return undefined;
};

/**
 * Builds a deterministic thread identifier used to group requests and logs.
 *
 * @param connectorId Identifier of the connector emitting the event.
 * @param chatId Identifier of the chat within the connector domain.
 * @returns Thread key composed of the connector and chat identifiers.
 */
export const buildThreadKey = (connectorId: string, chatId: string): string =>
  `${connectorId}:${chatId}`;

/**
 * Resolves an idempotency key from a request payload using well-known fields.
 *
 * @param body Raw request body originating from the transport layer.
 * @returns String representation of the idempotency key, if present.
 */
export const pickIdempotencyKey = (body: unknown): string | undefined => {
  if (!isRecord(body)) {
    return undefined;
  }

  const key = toStringOrUndefined(body.idempotencyKey);

  if (key !== undefined) {
    return key;
  }

  if (!isRecord(body.payload)) {
    return undefined;
  }

  return toStringOrUndefined(body.payload.updateId);
};
