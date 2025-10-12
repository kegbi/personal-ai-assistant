import {
  MonicaAccountReference,
  MonicaPaginatedResponse,
} from '../monica-common.types';
import { MonicaContactReference } from '../contacts/monica-contacts.types';

export interface MonicaReminder {
  id: number;
  uuid?: string;
  object: 'reminder';
  title: string;
  description: string | null;
  frequency_type: string;
  frequency_number: number | null;
  initial_date?: string | null;
  last_triggered_date?: string | null;
  next_expected_date?: string | null;
  delible?: boolean;
  account?: MonicaAccountReference;
  contact: MonicaContactReference;
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
