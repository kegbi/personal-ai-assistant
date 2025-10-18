import { Injectable, Logger } from '@nestjs/common';
import { MonicaClient } from '../monica.client';
import { parseMonicaReminderListResponse } from '../monica.guards';
import {
  MonicaReminder,
  MonicaReminderListResponse,
  ReminderDigestItem,
} from './monica-reminders.types';
import { AppConfigService } from '../../../config/config.service';

@Injectable()
export class MonicaRemindersService {
  private readonly logger = new Logger(MonicaRemindersService.name);
  private readonly pageSize = 100;

  constructor(
    private readonly monicaClient: MonicaClient,
    private readonly appConfig: AppConfigService,
  ) {}

  async fetchAllReminders(): Promise<MonicaReminder[]> {
    const reminders: MonicaReminder[] = [];
    let page = 1;
    const maxPages = Math.max(1, this.appConfig.monica.maxPages);

    while (true) {
      if (page > maxPages) {
        this.logger.warn(
          `Aborting reminders pagination after ${maxPages} pages (safety guard).`,
        );
        break;
      }

      const response = await this.monicaClient.get<MonicaReminderListResponse>(
        '/reminders',
        {
          query: {
            limit: this.pageSize,
            page,
          },
          parseResponse: parseMonicaReminderListResponse,
        },
      );

      if (!response) {
        break;
      }

      reminders.push(...response.data);

      if (!response.links?.next) {
        break;
      } else {
        page += 1;
      }
    }

    this.logger.debug(
      `Fetched ${reminders.length} Monica reminders across ${page - 1} page(s)`,
    );
    return reminders;
  }

  transformForDigest(reminders: MonicaReminder[]): ReminderDigestItem[] {
    return reminders.map((reminder) => ({
      reminderId: reminder.id,
      contactName: this.buildContactName(reminder),
      title: reminder.title,
      nextOccurrence: reminder.next_expected_date ?? null,
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
