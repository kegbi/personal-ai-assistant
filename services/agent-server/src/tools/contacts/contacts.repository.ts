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
  save(contact: ContactRecord): Promise<ContactRecord> {
    const byChat =
      this.contacts.get(contact.chatId) ?? new Map<string, ContactRecord>();
    byChat.set(contact.id, contact);
    this.contacts.set(contact.chatId, byChat);
    return Promise.resolve(contact);
  }

  findById(chatId: string, id: string): Promise<ContactRecord | undefined> {
    const byChat = this.contacts.get(chatId);
    return Promise.resolve(byChat?.get(id));
  }

  list(chatId: string): Promise<ContactRecord[]> {
    const byChat = this.contacts.get(chatId);
    if (!byChat) {
      return Promise.resolve([]);
    }

    return Promise.resolve(Array.from(byChat.values()));
  }

  /**
   * Performs a case-insensitive substring search across contact names for a chat.
   *
   * @param chatId Identifier for the chat the contacts belong to.
   * @param query Search term supplied by the caller.
   * @param limit Maximum number of results to return.
   * @returns List of contacts whose names include the query fragment.
   */
  searchByName(
    chatId: string,
    query: string,
    limit: number,
  ): Promise<ContactRecord[]> {
    const normalizedQuery = query.toLowerCase();
    const boundedLimit = Math.max(limit, 0);

    return this.list(chatId).then((contacts) =>
      contacts
        .filter((contact) =>
          contact.name.toLowerCase().includes(normalizedQuery),
        )
        .slice(0, boundedLimit),
    );
  }
}
