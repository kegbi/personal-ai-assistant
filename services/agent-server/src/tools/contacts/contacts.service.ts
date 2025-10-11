import { Injectable } from '@nestjs/common';
import { ContactsRepository } from './contacts.repository';

interface ContactInput {
  id: string;
  name: string;
  birthday?: string;
}

@Injectable()
export class ContactsService {
  constructor(private readonly repository: ContactsRepository) {}

  // TODO: extend API with richer behaviors
  async createContact(input: ContactInput) {
    return this.repository.save(input);
  }

  async setBirthday(contactId: string, birthday: string) {
    const existing = await this.repository.findById(contactId);
    if (!existing) {
      throw new Error(`Contact ${contactId} not found`);
    }

    return this.repository.save({ ...existing, birthday });
  }
}
