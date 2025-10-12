import { Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { MonicaClient } from './monica.client';
import { MonicaRemindersService } from './reminders/monica-reminders.service';
import { MonicaContactsService } from './contacts/monica-contacts.service';
import { MonicaNotesService } from './notes/monica-notes.service';

@Module({
  imports: [ConfigModule],
  providers: [
    MonicaClient,
    MonicaRemindersService,
    MonicaContactsService,
    MonicaNotesService,
  ],
  exports: [
    MonicaClient,
    MonicaRemindersService,
    MonicaContactsService,
    MonicaNotesService,
  ],
})
export class MonicaModule {}
