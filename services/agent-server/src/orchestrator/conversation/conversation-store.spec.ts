import { InputNormalizer } from '../input-normalizer.service';
import type { ConversationMemory } from './conversation-store';
import { ConversationStore } from './conversation-store';
import type { MemoryMessage } from '../../memory/memory.service';
import { NormalizedEventDto } from '../../api/transport/dto/normalized-event.dto';

class InMemoryConversationMemory implements ConversationMemory {
  private readonly windows = new Map<string, MemoryMessage[]>();

  pushMessage(threadKey: string, message: MemoryMessage): Promise<void> {
    const window = this.windows.get(threadKey) ?? [];
    window.push(message);
    this.windows.set(threadKey, window);
    return Promise.resolve();
  }

  getWindow(threadKey: string): Promise<MemoryMessage[]> {
    return Promise.resolve(this.windows.get(threadKey) ?? []);
  }
}

describe('ConversationStore', () => {
  it('persists normalized user messages with metadata', async () => {
    const memory = new InMemoryConversationMemory();
    const store = new ConversationStore(memory, new InputNormalizer());
    const event = new NormalizedEventDto();
    event.connectorId = 'telegram';
    event.chatId = 'chat-1';
    event.type = 'text';
    event.text = '  hello world  ';
    event.idempotencyKey = 'idem-1';

    await store.appendUser('thread-1', event);

    const window = await memory.getWindow('thread-1');
    expect(window).toHaveLength(1);
    expect(window[0]).toEqual({
      role: 'user',
      content: 'hello world',
      meta: {
        idempotencyKey: 'idem-1',
        connectorId: 'telegram',
      },
    });
  });

  it('delegates window loading to the memory service', async () => {
    const memory = new InMemoryConversationMemory();
    const store = new ConversationStore(memory, new InputNormalizer());
    const windowMessage: MemoryMessage = {
      role: 'assistant',
      content: 'Hi there',
    };
    await memory.pushMessage('thread-2', windowMessage);

    const window = await store.loadWindow('thread-2');
    expect(window).toEqual([windowMessage]);
  });
});
