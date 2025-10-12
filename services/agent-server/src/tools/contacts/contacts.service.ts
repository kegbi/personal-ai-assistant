import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ContactsRepository, type ContactRecord } from './contacts.repository';

interface ContactInput {
  name: string;
  birthday?: string;
  id?: string;
}

@Injectable()
export class ContactsService {
  constructor(private readonly repository: ContactsRepository) {}

  // TODO: extend API with richer behaviors
  async createContact(
    chatId: string,
    input: ContactInput,
  ): Promise<ContactRecord> {
    const id = input.id?.trim() ?? randomUUID();

    return this.repository.save({
      chatId,
      id,
      name: input.name.trim(),
      birthday: input.birthday?.trim(),
    });
  }

  async setBirthday(
    chatId: string,
    contactId: string,
    birthday: string,
  ): Promise<ContactRecord> {
    const existing = await this.repository.findById(chatId, contactId);
    if (!existing) {
      throw new Error(`Contact ${contactId} not found`);
    }

    return this.repository.save({
      ...existing,
      birthday: birthday.trim(),
    });
  }

  async findContact(
    chatId: string,
    contactId: string,
  ): Promise<ContactRecord | undefined> {
    return this.repository.findById(chatId, contactId);
  }

  async listContacts(chatId: string): Promise<ContactRecord[]> {
    return this.repository.list(chatId);
  }
}
