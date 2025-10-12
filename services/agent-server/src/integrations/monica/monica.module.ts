import { Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { MonicaClient } from './monica.client';
import { MonicaRemindersService } from './reminders/monica-reminders.service';
import { MonicaContactsService } from './contacts/monica-contacts.service';

@Module({
  imports: [ConfigModule],
  providers: [MonicaClient, MonicaRemindersService, MonicaContactsService],
  exports: [MonicaClient, MonicaRemindersService, MonicaContactsService],
})
export class MonicaModule {}
