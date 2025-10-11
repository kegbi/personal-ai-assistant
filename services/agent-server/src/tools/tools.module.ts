import { Module } from '@nestjs/common';
import { QuotesModule } from './quotes/quotes.module';
import { ContactsModule } from './contacts/contacts.module';

@Module({
  imports: [QuotesModule, ContactsModule],
  exports: [QuotesModule, ContactsModule],
})
export class ToolsModule {}
