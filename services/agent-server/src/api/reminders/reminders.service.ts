import { Injectable } from '@nestjs/common';
import { differenceInCalendarDays, format, isSameDay, parseISO, startOfDay } from 'date-fns';
import { AppConfigService } from '../../config/config.service';
import { MonicaRemindersService } from '../../integrations/monica/reminders/monica-reminders.service';
import { ReminderItem, RemindersMessageResponse } from './reminders.types';
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
          nextDate: reminder.next_expected_date ?? null,
          frequencyType: reminder.frequency_type,
          frequencyNumber: reminder.frequency_number,
        },
      };
    });

    return items;
  }

  async getRemindersTodayMessage(): Promise<RemindersMessageResponse> {
    const reminders = await this.getReminders();
    return this.buildRemindersDigest(reminders);
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

  private buildRemindersDigest(
    reminders: ReminderItem[],
  ): RemindersMessageResponse {
    const today = startOfDay(new Date());
    const todayLabel = format(today, 'dd-MM-yyyy');

    const todaysReminders: ReminderItem[] = [];
    const upcomingReminders: Array<{ date: Date; item: ReminderItem; originalIndex: number }> = [];

    reminders.forEach((reminder, index) => {
      const eventDate = this.resolveReminderDate(reminder);
      if (!eventDate) {
        return;
      }

      const normalizedDate = startOfDay(eventDate);

      if (isSameDay(normalizedDate, today)) {
        todaysReminders.push(reminder);
        return;
      }

      const diff = differenceInCalendarDays(normalizedDate, today);
      if (diff >= 1 && diff <= 3) {
        upcomingReminders.push({ date: normalizedDate, item: reminder, originalIndex: index });
      }
    });

    upcomingReminders.sort((a, b) => {
      const diff = a.date.getTime() - b.date.getTime();
      if (diff !== 0) {
        return diff;
      }
      return a.originalIndex - b.originalIndex;
    });

    const upcomingByDate: Array<{ label: string; items: ReminderItem[] }> = [];
    upcomingReminders.forEach(({ date, item }) => {
      const label = format(date, 'dd-MM-yyyy');
      const existingGroup = upcomingByDate.find((group) => group.label === label);
      if (existingGroup) {
        existingGroup.items.push(item);
        return;
      }
      upcomingByDate.push({ label, items: [item] });
    });

    const lines: string[] = [];

    lines.push(`Events for today (${todayLabel}):`);
    if (todaysReminders.length === 0) {
      lines.push('No events for today.');
    } else {
      todaysReminders.forEach((reminder) => {
        lines.push(this.formatReminderLine(reminder));
      });
    }

    lines.push('');
    lines.push('Events for nearest 3 days:');
    if (upcomingByDate.length === 0) {
      lines.push('No events for the next 3 days.');
    } else {
      upcomingByDate.forEach((group) => {
        lines.push(`${group.label}:`);
        group.items.forEach((reminder) => {
          lines.push(this.formatReminderLine(reminder));
        });
      });
    }

    const dataAvailable =
      todaysReminders.length > 0 || upcomingByDate.length > 0;

    return {
      message: lines.join('\n'),
      dataAvailable,
    };
  }

  private resolveReminderDate(reminder: ReminderItem): Date | null {
    const dateSource = reminder.event.nextDate ?? reminder.event.initialDate;
    if (!dateSource) {
      return null;
    }

    try {
      const parsedDate = parseISO(dateSource);
      return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
    } catch {
      return null;
    }
  }

  private formatReminderLine(reminder: ReminderItem): string {
    const name = reminder.contact.fullName ?? 'Unknown contact';
    const profileUrl = reminder.contact.websiteUrl ?? 'N/A';
    return `${name} (${profileUrl}): ${reminder.event.title}`;
  }
}
