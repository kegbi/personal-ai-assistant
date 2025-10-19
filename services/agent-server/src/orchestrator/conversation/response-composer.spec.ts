import type { BaseMessage } from '@langchain/core/messages';
import { AIMessage } from '@langchain/core/messages';
import { ResponseComposer } from './response-composer';

class StubResponseBuilder {
  readonly calls: Array<{
    chatId: string;
    transcript: BaseMessage[];
    generatedFromIndex: number;
    elapsedMs?: number;
  }> = [];

  build(
    chatId: string,
    transcript: BaseMessage[],
    generatedFromIndex: number,
    elapsedMs?: number,
  ) {
    this.calls.push({ chatId, transcript, generatedFromIndex, elapsedMs });
    return {
      text: 'done',
      meta: { elapsedMs },
    };
  }
}

describe('ResponseComposer', () => {
  it('delegates to the response builder with provided parameters', () => {
    const builder = new StubResponseBuilder();
    const composer = new ResponseComposer(
      builder as unknown as {
        build: (
          chatId: string,
          transcript: BaseMessage[],
          generatedFromIndex: number,
          elapsedMs?: number,
        ) => { text: string; meta?: Record<string, unknown> };
      },
    );

    const transcript = [new AIMessage('Hello')];
    const result = composer.compose('chat-1', transcript, 0, 42);

    expect(builder.calls).toHaveLength(1);
    expect(builder.calls[0]).toEqual({
      chatId: 'chat-1',
      transcript,
      generatedFromIndex: 0,
      elapsedMs: 42,
    });
    expect(result).toEqual({ text: 'done', meta: { elapsedMs: 42 } });
  });
});
