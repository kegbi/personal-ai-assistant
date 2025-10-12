import { Controller, Get } from '@nestjs/common';
import { RemindersService } from './reminders.service';
import { RemindersResponse } from './reminders.types';

@Controller('reminders')
export class RemindersController {
  constructor(private readonly remindersService: RemindersService) {}

  @Get('upcoming')
  async getUpcomingReminders(): Promise<RemindersResponse> {
    const items = await this.remindersService.getReminders();
    return { items };
  }
}

