import { Module } from '@nestjs/common';
import { ContactsModule } from './contacts/contacts.module';
import { MonicaModule } from '../integrations/monica/monica.module';
import { RemindersModule } from '../api/reminders/reminders.module';

@Module({
  imports: [ContactsModule, MonicaModule, RemindersModule],
  exports: [ContactsModule, MonicaModule, RemindersModule],
})
export class ToolsModule {}
