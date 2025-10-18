import { Module } from '@nestjs/common';
import { ContactsModule } from './contacts/contacts.module';
import { DatesService } from './dates/dates.service';
import { MonicaModule } from '../integrations/monica/monica.module';
import { RemindersModule } from '../api/reminders/reminders.module';

@Module({
  imports: [ContactsModule, MonicaModule, RemindersModule],
  providers: [DatesService],
  exports: [ContactsModule, MonicaModule, RemindersModule, DatesService],
})
export class ToolsModule {}
