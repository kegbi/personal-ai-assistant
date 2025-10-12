import { MonicaPaginatedResponse } from '../monica-common.types';

export interface MonicaReminderInformationDate {
  name: string;
  is_birthdate_approximate: string | null;
  birthdate: string | null;
}

export interface MonicaReminderContact {
  id: number;
  object: 'contact';
  first_name: string | null;
  last_name: string | null;
  gender: string | null;
  is_partial: boolean;
  information?: {
    dates?: MonicaReminderInformationDate[];
  };
}

export interface MonicaReminder {
  id: number;
  object: 'reminder';
  title: string;
  description: string | null;
  frequency_type: string;
  frequency_number: number | null;
  last_triggered_date: string | null;
  next_expected_date: string | null;
  contact: MonicaReminderContact;
  created_at: string;
  updated_at: string;
}

export type MonicaReminderListResponse = MonicaPaginatedResponse<MonicaReminder>;

export interface ReminderDigestItem {
  reminderId: number;
  contactName: string;
  title: string;
  nextOccurrence: string | null;
}

