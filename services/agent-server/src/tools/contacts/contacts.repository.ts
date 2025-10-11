import { Injectable } from '@nestjs/common';

interface ContactRecord {
  id: string;
  name: string;
  birthday?: string;
}

@Injectable()
export class ContactsRepository {
  private readonly contacts = new Map<string, ContactRecord>();

  // TODO: replace with persistent storage
  async save(contact: ContactRecord): Promise<ContactRecord> {
    this.contacts.set(contact.id, contact);
    return contact;
  }

  async findById(id: string): Promise<ContactRecord | undefined> {
    return this.contacts.get(id);
  }
}
