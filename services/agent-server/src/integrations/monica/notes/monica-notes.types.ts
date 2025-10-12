import {
  MonicaAccountReference,
  MonicaPaginatedResponse,
} from '../monica-common.types';

export interface MonicaNoteContactInformationDate {
  name?: string;
  is_birthdate_approximate?: string | null;
  birthdate?: string | null;
}

export interface MonicaNoteContactInformation {
  dates?: MonicaNoteContactInformationDate[];
}

export interface MonicaNoteContact {
  id: number;
  object: 'contact';
  first_name: string | null;
  last_name: string | null;
  gender: string | null;
  is_partial: boolean;
  information?: MonicaNoteContactInformation;
  account?: MonicaAccountReference;
}

export interface MonicaNote {
  id: number;
  object: 'note';
  body: string;
  is_favorited: boolean;
  favorited_at: string | null;
  account: MonicaAccountReference;
  contact: MonicaNoteContact;
  created_at: string;
  updated_at: string;
}

export type MonicaNotesListResponse = MonicaPaginatedResponse<MonicaNote>;

export interface MonicaNoteResponse {
  data: MonicaNote;
}

export interface MonicaListNotesParams {
  limit?: number;
  page?: number;
}

export interface MonicaListContactNotesParams extends MonicaListNotesParams {
  contactId: number;
}

export interface MonicaCreateNotePayload {
  body: string;
  contact_id: number;
  is_favorited: 0 | 1;
}

export interface MonicaUpdateNotePayload {
  body: string;
  contact_id: number;
  is_favorited: 0 | 1;
}

export interface MonicaDeleteNoteResponse {
  deleted: boolean;
  id: number;
}
