import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../config/config.service';
import { MonicaRemindersService } from '../../integrations/monica/reminders/monica-reminders.service';
import { ReminderItem } from './reminders.types';
import { MonicaReminder } from '../../integrations/monica/reminders/monica-reminders.types';

@Injectable()
export class RemindersService {
  constructor(
    private readonly remindersService: MonicaRemindersService,
    private readonly configService: AppConfigService,
  ) {}

  async getReminders(): Promise<ReminderItem[]> {
    const reminders = await this.remindersService.fetchAllReminders();

    const baseWebsiteUrl = this.stripTrailingSlash(
      this.configService.monica.websiteUrl,
    );
    const websiteBase = baseWebsiteUrl.length > 0 ? baseWebsiteUrl : null;

    const sortedReminders = reminders
      .slice()
      .sort((a, b) => this.compareReminderDates(a, b));

    const items = sortedReminders.map((reminder) => {
      const contact = reminder.contact;
      const info = contact.information ?? {};
      const birthdate = info.birthdate?.date ?? null;
      const avatarUrl = info.avatar?.url ?? null;

      const fallbackNameParts = [contact.first_name, contact.last_name].filter(
        (value): value is string => Boolean(value && value.trim()),
      );
      const fallbackName = fallbackNameParts.join(' ').trim();
      const fullName =
        contact.complete_name ?? (fallbackName.length > 0 ? fallbackName : null);

      const apiUrl = contact.url ?? null;
      const websiteUrl =
        contact.hash_id && websiteBase
          ? `${websiteBase}/people/${contact.hash_id}`
          : null;

      return {
        contact: {
          id: contact.id,
          uuid: contact.uuid ?? null,
          fullName,
          birthdate,
          apiUrl,
          websiteUrl,
          avatarUrl,
          gender: contact.gender_type ?? null,
        },
        event: {
          title: reminder.title,
          id: reminder.id,
          uuid: reminder.uuid ?? null,
          description: reminder.description,
          initialDate: reminder.initial_date ?? null,
          frequencyType: reminder.frequency_type,
          frequencyNumber: reminder.frequency_number,
        },
      };
    });

    return items;
  }

  private compareReminderDates(a: MonicaReminder, b: MonicaReminder): number {
    const dateA = a.next_expected_date ?? a.initial_date ?? null;
    const dateB = b.next_expected_date ?? b.initial_date ?? null;

    if (dateA === null && dateB === null) {
      return 0;
    }

    if (dateA === null) {
      return 1;
    }

    if (dateB === null) {
      return -1;
    }

    return new Date(dateA).getTime() - new Date(dateB).getTime();
  }

  private stripTrailingSlash(value: string): string {
    return value.replace(/\/+$/, '');
  }
}
