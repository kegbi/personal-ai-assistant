import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { TranscriptPersister } from './transcript-persister';

class StubGeneratedPersister {
  readonly calls: Array<{ threadKey: string; messages: unknown[] }> = [];

  persistGeneratedMessages(
    threadKey: string,
    messages: unknown[],
  ): Promise<void> {
    this.calls.push({ threadKey, messages });
    return Promise.resolve();
  }
}

describe('TranscriptPersister', () => {
  it('persists messages starting from the generated index', async () => {
    const stub = new StubGeneratedPersister();
    const persister = new TranscriptPersister(
      stub as unknown as {
        persistGeneratedMessages: (
          threadKey: string,
          messages: unknown[],
        ) => Promise<void>;
      },
    );

    const transcript = [
      new SystemMessage('system'),
      new HumanMessage('user'),
      new HumanMessage('assistant draft'),
    ];

    await persister.persist('thread-1', transcript, 2);

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toEqual({
      threadKey: 'thread-1',
      messages: transcript.slice(2),
    });
  });

  it('skips persistence when no generated messages exist', async () => {
    const stub = new StubGeneratedPersister();
    const persister = new TranscriptPersister(
      stub as unknown as {
        persistGeneratedMessages: (
          threadKey: string,
          messages: unknown[],
        ) => Promise<void>;
      },
    );

    await persister.persist('thread-2', [new HumanMessage('hello')], 1);

    expect(stub.calls).toHaveLength(0);
  });
});
