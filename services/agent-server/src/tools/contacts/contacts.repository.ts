import { Injectable } from '@nestjs/common';

export interface ContactRecord {
  chatId: string;
  id: string;
  name: string;
  birthday?: string;
}

@Injectable()
export class ContactsRepository {
  private readonly contacts = new Map<string, Map<string, ContactRecord>>();

  // TODO: replace with persistent storage
  async save(contact: ContactRecord): Promise<ContactRecord> {
    const byChat = this.contacts.get(contact.chatId) ?? new Map<string, ContactRecord>();
    byChat.set(contact.id, contact);
    this.contacts.set(contact.chatId, byChat);
    return contact;
  }

  async findById(chatId: string, id: string): Promise<ContactRecord | undefined> {
    const byChat = this.contacts.get(chatId);
    return byChat?.get(id);
  }

  async list(chatId: string): Promise<ContactRecord[]> {
    const byChat = this.contacts.get(chatId);
    if (!byChat) {
      return [];
    }

    return Array.from(byChat.values());
  }
}
