import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { NormalizedEventDto } from '../../api/transport/dto/normalized-event.dto';
import type {
  GraphDriver,
  GraphStreamChunk,
  RunInput,
  RunResult,
} from '../graph/graph-driver';
import type { ConversationStore } from './conversation-store';
import type {
  TranscriptAssembler,
  TranscriptAssembly,
} from './transcript-assembler';
import type { TranscriptPersister } from './transcript-persister';
import type { ResponseComposer } from './response-composer';
import {
  ConversationOrchestrator,
  type ConversationOutcome,
} from './conversation-orchestrator';
import { InputNormalizer } from '../input-normalizer.service';
import type { MemoryMessage } from '../../memory/memory.service';

class StubConversationStore implements ConversationStore {
  readonly appendUserCalls: Array<{
    threadKey: string;
    event: NormalizedEventDto;
  }> = [];
  private readonly windows = new Map<
    string,
    ReturnType<ConversationStore['loadWindow']>
  >();

  constructor(
    initialWindows: Record<
      string,
      ReturnType<ConversationStore['loadWindow']>
    > = {},
  ) {
    for (const [key, value] of Object.entries(initialWindows)) {
      this.windows.set(key, Promise.resolve(value));
    }
  }

  appendUser(threadKey: string, event: NormalizedEventDto): Promise<void> {
    this.appendUserCalls.push({ threadKey, event });
    return Promise.resolve();
  }

  loadWindow(threadKey: string) {
    return this.windows.get(threadKey) ?? Promise.resolve([]);
  }
}

class MockTranscriptAssembler implements TranscriptAssembler {
  constructor(
    private readonly windowAssembly: TranscriptAssembly,
    private readonly checkpointerAssembly: TranscriptAssembly,
  ) {}

  buildFromWindow(window: MemoryMessage[]): TranscriptAssembly {
    void window;
    return this.windowAssembly;
  }

  buildForCheckpointer(userContent: string): TranscriptAssembly {
    void userContent;
    return this.checkpointerAssembly;
  }
}

class StubTranscriptPersister implements TranscriptPersister {
  readonly calls: Array<{
    threadKey: string;
    transcript: BaseMessage[];
    generatedFromIndex: number;
  }> = [];

  persist(
    threadKey: string,
    transcript: BaseMessage[],
    generatedFromIndex: number,
  ): Promise<void> {
    this.calls.push({ threadKey, transcript, generatedFromIndex });
    return Promise.resolve();
  }
}

class StubResponseComposer implements ResponseComposer {
  readonly calls: Array<{
    chatId: string;
    transcript: unknown[];
    generatedFromIndex: number;
    elapsedMs?: number;
  }> = [];
  readonly response: ConversationOutcome['response'];

  constructor(responseText = 'completed') {
    this.response = {
      text: responseText,
      meta: { elapsedMs: 123 },
    };
  }

  compose(
    chatId: string,
    transcript: unknown[],
    generatedFromIndex: number,
    elapsedMs?: number,
  ) {
    this.calls.push({ chatId, transcript, generatedFromIndex, elapsedMs });
    return this.response;
  }
}

class StubGraphDriver implements GraphDriver {
  constructor(
    private readonly runResult: RunResult,
    private readonly streamChunks: GraphStreamChunk[],
  ) {}

  run(input: RunInput): Promise<RunResult> {
    void input;
    return Promise.resolve(this.runResult);
  }

  async *stream(input: RunInput): AsyncGenerator<GraphStreamChunk> {
    void input;
    for (const chunk of this.streamChunks) {
      await Promise.resolve();
      yield chunk;
    }
  }
}

const makeEvent = (
  overrides: Partial<NormalizedEventDto> = {},
): NormalizedEventDto => {
  const event = new NormalizedEventDto();
  event.connectorId = overrides.connectorId ?? 'telegram';
  event.chatId = overrides.chatId ?? 'chat-1';
  event.type = overrides.type ?? 'text';
  event.text = overrides.text ?? 'hello';
  if (overrides.voiceUrl) event.voiceUrl = overrides.voiceUrl;
  if (overrides.idempotencyKey) event.idempotencyKey = overrides.idempotencyKey;
  if (overrides.payload) event.payload = overrides.payload;
  return event;
};

describe('ConversationOrchestrator', () => {
  const normalizer = new InputNormalizer();

  it('handles memory mode conversations', async () => {
    const store = new StubConversationStore({
      'thread-1': Promise.resolve([{ role: 'user', content: 'hi' }]),
    });
    const windowAssembly: TranscriptAssembly = {
      transcript: [new SystemMessage('sys'), new HumanMessage('user')],
      generatedFromIndex: 2,
    };
    const checkpointerAssembly: TranscriptAssembly = {
      transcript: [new HumanMessage('user')],
      generatedFromIndex: 0,
    };
    const assembler = new MockTranscriptAssembler(
      windowAssembly,
      checkpointerAssembly,
    );
    const persister = new StubTranscriptPersister();
    const responseComposer = new StubResponseComposer();
    const finalTranscript = [
      new SystemMessage('sys'),
      new HumanMessage('user'),
      new AIMessage('assistant'),
    ];
    const runResult: RunResult = {
      transcript: finalTranscript,
      generatedFromIndex: 2,
      elapsedMs: 50,
    };
    const graph = new StubGraphDriver(runResult, []);
    const orchestrator = new ConversationOrchestrator(
      store,
      assembler,
      persister,
      responseComposer,
      graph,
      normalizer,
    );

    const outcome = await orchestrator.handle({
      threadKey: 'thread-1',
      chatId: 'chat-1',
      event: makeEvent(),
      useCheckpointer: false,
    });

    expect(outcome.mode).toBe('memory');
    expect(outcome.transcript).toBe(finalTranscript);
    expect(outcome.generatedFromIndex).toBe(2);
    expect(outcome.elapsedMs).toBe(50);
    expect(outcome.windowLength).toBe(1);
    expect(outcome.response).toBe(responseComposer.response);
    expect(persister.calls).toHaveLength(1);
    expect(store.appendUserCalls).toHaveLength(1);
  });

  it('handles checkpointer mode conversations without touching memory', async () => {
    const store = new StubConversationStore();
    const windowAssembly: TranscriptAssembly = {
      transcript: [new SystemMessage('sys'), new HumanMessage('user')],
      generatedFromIndex: 2,
    };
    const checkpointerAssembly: TranscriptAssembly = {
      transcript: [new HumanMessage('user')],
      generatedFromIndex: 0,
    };
    const assembler = new MockTranscriptAssembler(
      windowAssembly,
      checkpointerAssembly,
    );
    const persister = new StubTranscriptPersister();
    const responseComposer = new StubResponseComposer();
    const finalTranscript = [
      new HumanMessage('user'),
      new AIMessage('assistant'),
    ];
    const runResult: RunResult = {
      transcript: finalTranscript,
      generatedFromIndex: 1,
      elapsedMs: 25,
    };
    const graph = new StubGraphDriver(runResult, []);
    const orchestrator = new ConversationOrchestrator(
      store,
      assembler,
      persister,
      responseComposer,
      graph,
      normalizer,
    );

    const outcome = await orchestrator.handle({
      threadKey: 'thread-2',
      chatId: 'chat-2',
      event: makeEvent(),
      useCheckpointer: true,
    });

    expect(outcome.mode).toBe('checkpointer');
    expect(outcome.transcript).toBe(finalTranscript);
    expect(outcome.generatedFromIndex).toBe(1);
    expect(outcome.elapsedMs).toBe(25);
    expect(outcome.windowLength).toBe(1);
    expect(persister.calls).toHaveLength(0);
    expect(store.appendUserCalls).toHaveLength(0);
  });

  it('streams memory mode events and resolves metadata once complete', async () => {
    const store = new StubConversationStore({
      'thread-3': Promise.resolve([{ role: 'user', content: 'hi' }]),
    });
    const windowAssembly: TranscriptAssembly = {
      transcript: [new SystemMessage('sys'), new HumanMessage('user')],
      generatedFromIndex: 2,
    };
    const checkpointerAssembly: TranscriptAssembly = {
      transcript: [new HumanMessage('user')],
      generatedFromIndex: 0,
    };
    const assembler = new MockTranscriptAssembler(
      windowAssembly,
      checkpointerAssembly,
    );
    const persister = new StubTranscriptPersister();
    const responseComposer = new StubResponseComposer();
    const finalTranscript = [
      new SystemMessage('sys'),
      new HumanMessage('user'),
      new AIMessage({ content: 'Hello world', id: 'ai-1' }),
    ];
    const internalChunk: GraphStreamChunk = {
      kind: 'internal',
      messages: finalTranscript,
    };
    const graph = new StubGraphDriver(
      {
        transcript: finalTranscript,
        generatedFromIndex: 2,
        elapsedMs: 30,
      },
      [
        { type: 'delta', text: 'Hello ' },
        { type: 'delta', text: 'world' },
        internalChunk,
      ],
    );
    const orchestrator = new ConversationOrchestrator(
      store,
      assembler,
      persister,
      responseComposer,
      graph,
      normalizer,
    );

    const stream = orchestrator.stream({
      threadKey: 'thread-3',
      chatId: 'chat-3',
      event: makeEvent(),
      useCheckpointer: false,
    });

    const collected: AgentStreamEvent[] = [];
    for await (const chunk of stream.events) {
      collected.push(chunk);
    }

    const outcome = await stream.result;

    expect(collected).toHaveLength(3);
    expect(collected[0]).toEqual({ type: 'delta', text: 'Hello ' });
    expect(collected[1]).toEqual({ type: 'delta', text: 'world' });
    expect(collected[2]).toEqual({
      type: 'final',
      text: responseComposer.response.text,
      meta: responseComposer.response.meta,
    });
    expect(outcome.mode).toBe('memory');
    expect(outcome.transcript).toBe(finalTranscript);
    expect(outcome.generatedFromIndex).toBe(2);
    expect(persister.calls).toHaveLength(1);
  });
});
