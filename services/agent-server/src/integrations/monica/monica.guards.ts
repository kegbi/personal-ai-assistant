import {
  MonicaContact,
  MonicaContactReference,
  MonicaContactResponse,
  MonicaContactsListResponse,
  MonicaDeleteContactResponse,
} from './contacts/monica-contacts.types';
import {
  MonicaReminder,
  MonicaReminderListResponse,
} from './reminders/monica-reminders.types';
import {
  MonicaDeleteNoteResponse,
  MonicaNote,
  MonicaNoteResponse,
  MonicaNotesListResponse,
} from './notes/monica-notes.types';
import {
  MonicaPaginatedResponse,
  MonicaPaginationLinks,
  MonicaPaginationMeta,
} from './monica-common.types';

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

const isNullableNumber = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isFinite(value));

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isBoolean = (value: unknown): value is boolean =>
  typeof value === 'boolean';

const isPaginationLinks = (value: unknown): value is MonicaPaginationLinks => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    'first' in value &&
    isNullableString(value.first) &&
    'last' in value &&
    isNullableString(value.last) &&
    'prev' in value &&
    isNullableString(value.prev) &&
    'next' in value &&
    isNullableString(value.next)
  );
};

const isPaginationMeta = (value: unknown): value is MonicaPaginationMeta => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    'current_page' in value &&
    isNumber(value.current_page) &&
    'last_page' in value &&
    isNumber(value.last_page) &&
    'path' in value &&
    typeof value.path === 'string' &&
    'per_page' in value &&
    (isNumber(value.per_page) || typeof value.per_page === 'string') &&
    'total' in value &&
    isNumber(value.total) &&
    'from' in value &&
    isNullableNumber(value.from) &&
    'to' in value &&
    isNullableNumber(value.to)
  );
};

const isPaginatedResponse = <T>(
  value: unknown,
  isItem: (candidate: unknown) => candidate is T,
): value is MonicaPaginatedResponse<T> => {
  if (!isRecord(value)) {
    return false;
  }

  const data = value.data;
  if (!Array.isArray(data) || !data.every(isItem)) {
    return false;
  }

  return (
    'links' in value &&
    isPaginationLinks(value.links) &&
    'meta' in value &&
    isPaginationMeta(value.meta)
  );
};

const isContactReference = (value: unknown): value is MonicaContactReference =>
  isRecord(value) &&
  'id' in value &&
  isNumber(value.id) &&
  'object' in value &&
  value.object === 'contact' &&
  'is_partial' in value &&
  isBoolean(value.is_partial);

const isMonicaContact = (value: unknown): value is MonicaContact => {
  if (!isRecord(value)) {
    return false;
  }

  const id = value.id;
  const objectType = value.object;
  const isPartial = value.is_partial;
  const isDead = value.is_dead;

  return (
    isNumber(id) &&
    objectType === 'contact' &&
    isBoolean(isPartial) &&
    isBoolean(isDead)
  );
};

const isMonicaContactResponse = (
  payload: unknown,
): payload is MonicaContactResponse =>
  isRecord(payload) && 'data' in payload && isMonicaContact(payload.data);

const isMonicaReminder = (value: unknown): value is MonicaReminder => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNumber(value.id) &&
    value.object === 'reminder' &&
    typeof value.title === 'string' &&
    'contact' in value &&
    isContactReference(value.contact)
  );
};

const isMonicaDeleteContactResponse = (
  payload: unknown,
): payload is MonicaDeleteContactResponse =>
  isRecord(payload) &&
  'deleted' in payload &&
  isBoolean(payload.deleted) &&
  'id' in payload &&
  isNumber(payload.id);

const isMonicaNote = (value: unknown): value is MonicaNote => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNumber(value.id) &&
    value.object === 'note' &&
    typeof value.body === 'string' &&
    isBoolean(value.is_favorited) &&
    isRecord(value.contact) &&
    isContactReference(value.contact)
  );
};

const isMonicaNoteResponse = (
  payload: unknown,
): payload is MonicaNoteResponse =>
  isRecord(payload) && 'data' in payload && isMonicaNote(payload.data);

const isMonicaDeleteNoteResponse = (
  payload: unknown,
): payload is MonicaDeleteNoteResponse =>
  isRecord(payload) &&
  'deleted' in payload &&
  isBoolean(payload.deleted) &&
  'id' in payload &&
  isNumber(payload.id);

/**
 * Validates and returns a Monica contacts list response.
 *
 * @param payload Raw payload retrieved from the Monica API.
 * @throws Error when payload does not match the expected structure.
 */
export const parseMonicaContactsListResponse = (
  payload: unknown,
): MonicaContactsListResponse => {
  if (!isPaginatedResponse(payload, isMonicaContact)) {
    throw new Error('Invalid Monica contacts list response payload.');
  }

  return payload;
};

/**
 * Validates and returns a Monica contact response.
 *
 * @param payload Raw payload retrieved from the Monica API.
 * @throws Error when payload does not match the expected structure.
 */
export const parseMonicaContactResponse = (
  payload: unknown,
): MonicaContactResponse => {
  if (!isMonicaContactResponse(payload)) {
    throw new Error('Invalid Monica contact response payload.');
  }

  return payload;
};

/**
 * Validates and returns a Monica delete contact response.
 *
 * @param payload Raw payload retrieved from the Monica API.
 * @throws Error when payload does not match the expected structure.
 */
export const parseMonicaDeleteContactResponse = (
  payload: unknown,
): MonicaDeleteContactResponse => {
  if (!isMonicaDeleteContactResponse(payload)) {
    throw new Error('Invalid Monica delete contact response payload.');
  }

  return payload;
};

/**
 * Validates and returns a Monica reminders list response.
 *
 * @param payload Raw payload retrieved from the Monica API.
 * @throws Error when payload does not match the expected structure.
 */
export const parseMonicaReminderListResponse = (
  payload: unknown,
): MonicaReminderListResponse => {
  if (!isPaginatedResponse(payload, isMonicaReminder)) {
    throw new Error('Invalid Monica reminders list response payload.');
  }

  return payload;
};

/**
 * Validates and returns a Monica notes list response.
 *
 * @param payload Raw payload retrieved from the Monica API.
 * @throws Error when payload does not match the expected structure.
 */
export const parseMonicaNotesListResponse = (
  payload: unknown,
): MonicaNotesListResponse => {
  if (!isPaginatedResponse(payload, isMonicaNote)) {
    throw new Error('Invalid Monica notes list response payload.');
  }

  return payload;
};

/**
 * Validates and returns a Monica note response.
 *
 * @param payload Raw payload retrieved from the Monica API.
 * @throws Error when payload does not match the expected structure.
 */
export const parseMonicaNoteResponse = (
  payload: unknown,
): MonicaNoteResponse => {
  if (!isMonicaNoteResponse(payload)) {
    throw new Error('Invalid Monica note response payload.');
  }

  return payload;
};

/**
 * Validates and returns a Monica delete note response.
 *
 * @param payload Raw payload retrieved from the Monica API.
 * @throws Error when payload does not match the expected structure.
 */
export const parseMonicaDeleteNoteResponse = (
  payload: unknown,
): MonicaDeleteNoteResponse => {
  if (!isMonicaDeleteNoteResponse(payload)) {
    throw new Error('Invalid Monica delete note response payload.');
  }

  return payload;
};
