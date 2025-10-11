import { Module } from '@nestjs/common';
import { ContactsService } from './contacts.service';
import { ContactsRepository } from './contacts.repository';

@Module({
  providers: [ContactsService, ContactsRepository],
  exports: [ContactsService],
})
export class ContactsModule {}
