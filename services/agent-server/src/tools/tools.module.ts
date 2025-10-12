import { Module } from '@nestjs/common';
import { ContactsModule } from './contacts/contacts.module';
import { MonicaModule } from '../integrations/monica/monica.module';

@Module({
  imports: [ContactsModule, MonicaModule],
  exports: [ContactsModule, MonicaModule],
})
export class ToolsModule {}
