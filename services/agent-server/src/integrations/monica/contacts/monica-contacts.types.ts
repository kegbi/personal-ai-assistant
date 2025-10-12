import {
  MonicaAccountReference,
  MonicaPaginatedResponse,
} from '../monica-common.types';
import { MonicaNote } from '../notes/monica-notes.types';

export type MonicaContactsSort =
  | 'created_at'
  | '-created_at'
  | 'updated_at'
  | '-updated_at';

export interface MonicaSpecialDate {
  is_age_based: boolean | null;
  is_year_unknown: boolean | null;
  date: string | null;
}

export interface MonicaContactReference {
  id: number;
  object: 'contact';
  first_name: string | null;
  last_name: string | null;
  nickname: string | null;
  gender: string | null;
  is_partial: boolean;
  is_dead?: boolean;
  information?: {
    birthdate?: MonicaSpecialDate | null;
    deceased_date?: MonicaSpecialDate | null;
  };
  account?: MonicaAccountReference;
}

export interface MonicaRelationshipSummary {
  total: number;
  contacts: MonicaRelationshipContact[];
}

export interface MonicaRelationshipContact {
  relationship: {
    id: number;
    name: string | null;
  };
  contact: MonicaContactReference;
}

export interface MonicaContactRelationships {
  love?: MonicaRelationshipSummary;
  family?: MonicaRelationshipSummary;
  friend?: MonicaRelationshipSummary;
  work?: MonicaRelationshipSummary;
  [key: string]: MonicaRelationshipSummary | undefined;
}

export interface MonicaAvatarInfo {
  url: string | null;
  source: string | null;
  default_avatar_color?: string | null;
}

export interface MonicaHowYouMet {
  general_information?: string | null;
  first_met_date?: MonicaSpecialDate | null;
  first_met_through_contact?: MonicaContactReference | null;
}

export interface MonicaContactInformation {
  relationships?: MonicaContactRelationships;
  dates?: {
    birthdate?: MonicaSpecialDate | null;
    deceased_date?: MonicaSpecialDate | null;
    first_met_date?: MonicaSpecialDate | null;
  };
  career?: {
    job: string | null;
    company: string | null;
  } | null;
  avatar?: MonicaAvatarInfo | null;
  food_preferences?: string | null;
  food_preferencies?: string | null;
  how_you_met?: MonicaHowYouMet | null;
}

export interface MonicaCountry {
  id: string;
  object: 'country';
  name: string;
  iso: string;
}

export interface MonicaAddress {
  id: number;
  object: 'address';
  name: string | null;
  street: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
  latitude: number | null;
  longitude: number | null;
  country: MonicaCountry | null;
  url?: string;
  account?: MonicaAccountReference;
  contact?: MonicaContactReference;
  created_at: string;
  updated_at: string;
}

export interface MonicaTag {
  id: number;
  object: 'tag';
  name: string;
  name_slug: string;
  account: MonicaAccountReference;
  created_at: string;
  updated_at: string;
}

export interface MonicaContactStatistics {
  number_of_calls: number;
  number_of_notes: number;
  number_of_activities: number;
  number_of_reminders: number;
  number_of_tasks: number;
  number_of_gifts: number;
  number_of_debts: number;
}

export interface MonicaContactFieldType {
  id: number;
  object: 'contactfieldtype';
  name: string;
  fontawesome_icon: string | null;
  protocol: string | null;
  delible: boolean;
  type: string | null;
  account: MonicaAccountReference;
  created_at: string;
  updated_at: string;
}

export interface MonicaContactField {
  id: number;
  object: 'contactfield';
  content: string | null;
  contact_field_type: MonicaContactFieldType;
  account: MonicaAccountReference;
  contact: MonicaContactReference;
  created_at: string;
  updated_at: string;
}

export interface MonicaContact {
  id: number;
  object: 'contact';
  hash_id?: string;
  first_name: string | null;
  last_name: string | null;
  nickname: string | null;
  complete_name?: string | null;
  description?: string | null;
  gender: string | null;
  gender_type?: string | null;
  is_starred?: boolean;
  is_partial: boolean;
  is_active?: boolean;
  is_dead: boolean;
  is_me?: boolean;
  last_called: string | null;
  last_activity_together: string | { date: string; timezone_type: number; timezone: string } | null;
  stay_in_touch_frequency: number | null;
  stay_in_touch_trigger_date: string | null;
  information?: MonicaContactInformation;
  addresses?: MonicaAddress[];
  tags?: MonicaTag[];
  statistics?: MonicaContactStatistics;
  account?: MonicaAccountReference;
  created_at: string;
  updated_at: string;
  contactFields?: MonicaContactField[];
  notes?: MonicaNote[];
  url?: string;
}

export type MonicaContactsListResponse = MonicaPaginatedResponse<MonicaContact>;

export interface MonicaContactResponse {
  data: MonicaContact;
}

export interface MonicaListContactsParams {
  limit?: number;
  page?: number;
  sort?: MonicaContactsSort;
  query?: string;
}

export interface MonicaSearchContactsParams
  extends Omit<MonicaListContactsParams, 'query'> {
  query: string;
}

export interface MonicaGetContactOptions {
  includeContactFields?: boolean;
}

export interface MonicaUpdateContactPayload {
  first_name: string;
  last_name?: string | null;
  nickname?: string | null;
  gender_id: number;
  birthdate_day?: number | null;
  birthdate_month?: number | null;
  birthdate_year?: number | null;
  birthdate_is_age_based?: boolean;
  is_birthdate_known: boolean;
  birthdate_age?: number | null;
  is_partial?: boolean;
  is_deceased: boolean;
  is_deceased_date_known: boolean;
  deceased_date_add_reminder?: boolean;
  deceased_date_day?: number | null;
  deceased_date_month?: number | null;
  deceased_date_year?: number | null;
  deceased_date_is_age_based?: boolean;
  deceased_date_is_year_unknown?: boolean;
  deceased_date_age?: number | null;
}

export interface MonicaUpdateContactCareerPayload {
  job?: string | null;
  company?: string | null;
}

export interface MonicaDeleteContactResponse {
  deleted: boolean;
  id: number;
}
