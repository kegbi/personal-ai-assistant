import { Injectable, Logger } from '@nestjs/common';
import { MonicaClient } from '../monica.client';
import {
  MonicaReminder,
  MonicaReminderListResponse,
  ReminderDigestItem,
} from './monica-reminders.types';

@Injectable()
export class MonicaRemindersService {
  private readonly logger = new Logger(MonicaRemindersService.name);
  private readonly pageSize = 100;

  constructor(private readonly monicaClient: MonicaClient) {}

  async fetchAllReminders(): Promise<MonicaReminder[]> {
    const reminders: MonicaReminder[] = [];
    let page = 1;
    let hasNext = true;

    while (hasNext) {
      const response = await this.monicaClient.get<MonicaReminderListResponse>(
        '/reminders',
        {
          query: {
            limit: this.pageSize,
            page,
          },
        },
      );

      if (!response) {
        throw new Error('Monica API returned no content while listing reminders.');
      }

      reminders.push(...response.data);

      if (!response.links?.next) {
        hasNext = false;
      } else {
        page += 1;
      }
    }

    this.logger.debug(`Fetched ${reminders.length} Monica reminders`);
    return reminders;
  }

  transformForDigest(reminders: MonicaReminder[]): ReminderDigestItem[] {
    return reminders.map((reminder) => ({
      reminderId: reminder.id,
      contactName: this.buildContactName(reminder),
      title: reminder.title,
      nextOccurrence: reminder.next_expected_date,
    }));
  }

  private buildContactName(reminder: MonicaReminder): string {
    const { contact } = reminder;

    const parts = [
      contact.first_name?.trim(),
      contact.last_name?.trim(),
    ].filter(Boolean);

    if (parts.length) {
      return parts.join(' ');
    }

    return '[unknown contact]';
  }
}
