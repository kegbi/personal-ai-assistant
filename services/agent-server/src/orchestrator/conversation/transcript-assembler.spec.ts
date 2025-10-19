import type { BaseMessage } from '@langchain/core/messages';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { MemoryMessage } from '../../memory/memory.service';
import type { ConversationHistoryBuilder } from './transcript-assembler';
import { TranscriptAssembler } from './transcript-assembler';

class StubHistoryBuilder implements ConversationHistoryBuilder {
  constructor(
    private readonly transcript: BaseMessage[],
    private readonly tracker: MemoryMessage[][],
  ) {}

  buildHistory(window: MemoryMessage[]): BaseMessage[] {
    this.tracker.push(window);
    return this.transcript;
  }
}

describe('TranscriptAssembler', () => {
  it('builds transcripts from memory windows', () => {
    const tracker: MemoryMessage[][] = [];
    const transcript: BaseMessage[] = [
      new SystemMessage('system'),
      new HumanMessage('user'),
    ];
    const builder = new StubHistoryBuilder(transcript, tracker);
    const assembler = new TranscriptAssembler(builder);
    const window: MemoryMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];

    const result = assembler.buildFromWindow(window);

    expect(tracker).toEqual([window]);
    expect(result.transcript).toBe(transcript);
    expect(result.generatedFromIndex).toBe(transcript.length);
  });

  it('creates single-message transcripts for checkpointer mode', () => {
    const builder = new StubHistoryBuilder([], []);
    const assembler = new TranscriptAssembler(builder);

    const result = assembler.buildForCheckpointer('hello');

    expect(result.transcript).toEqual([new HumanMessage('hello')]);
    expect(result.generatedFromIndex).toBe(0);
  });
});
