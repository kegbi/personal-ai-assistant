export interface ReminderContact {
  id: number;
  uuid: string | null;
  fullName: string | null;
  birthdate: string | null;
  apiUrl: string | null;
  websiteUrl: string | null;
  avatarUrl: string | null;
  gender: string | null;
}

export interface ReminderMetadata {
  title: string;
  id: number;
  uuid: string | null;
  description: string | null;
  initialDate: string | null;
  nextDate: string | null;
  frequencyType: string;
  frequencyNumber: number | null;
}

export interface ReminderItem {
  contact: ReminderContact;
  event: ReminderMetadata;
}

export interface RemindersResponse {
  items: ReminderItem[];
}

export interface RemindersMessageResponse {
  message: string;
  dataAvailable: boolean;
}
