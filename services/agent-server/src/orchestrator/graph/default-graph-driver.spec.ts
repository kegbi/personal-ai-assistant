import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { DefaultGraphDriver, type GraphExecutor } from './default-graph-driver';
import type { GraphStreamChunk, RunInput } from './graph-driver';

const createDriver = (executor: GraphExecutor): DefaultGraphDriver =>
  new DefaultGraphDriver(executor);

describe('DefaultGraphDriver', () => {
  it('invokes the graph and returns filtered transcript', async () => {
    const assistant = new AIMessage({ content: 'Hi there' });
    const executor: GraphExecutor = {
      invoke() {
        return Promise.resolve({
          messages: [assistant, 'ignored'],
        });
      },
      stream() {
        const emptyEntries: ReadonlyArray<readonly [string, unknown]> = [];
        const iterator = (async function* (): AsyncGenerator<
          readonly [string, unknown]
        > {
          await Promise.resolve();
          yield* emptyEntries;
        })();
        return Promise.resolve(iterator);
      },
    };

    const driver = createDriver(executor);
    const input: RunInput = {
      history: [new HumanMessage('Hello')],
      threadKey: 'thread-1',
      generatedFromIndex: 1,
      useCheckpointer: false,
    };

    const result = await driver.run(input);
    expect(result.transcript).toEqual([assistant]);
    expect(result.generatedFromIndex).toBe(1);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('translates stream entries into delta, tool, and internal chunks', async () => {
    const firstChunk = new AIMessage({
      id: 'ai-1',
      content: [{ type: 'text', text: 'Hello' }],
      tool_calls: [
        { id: 'tool-1', name: 'lookup', args: { query: 'weather' } },
      ],
    });
    const secondChunk = new AIMessage({
      id: 'ai-1',
      content: [{ type: 'text', text: 'Hello world' }],
      tool_calls: [
        { id: 'tool-1', name: 'lookup', args: { query: 'weather' } },
      ],
    });
    const finalMessages = [
      new HumanMessage('Hello'),
      new AIMessage({ id: 'ai-1', content: 'Hello world' }),
    ];

    const executor: GraphExecutor = {
      invoke() {
        return Promise.resolve({ messages: [] });
      },
      stream() {
        const firstEntry: readonly [string, unknown] = [
          'messages',
          [firstChunk],
        ];
        const secondEntry: readonly [string, unknown] = [
          'messages',
          [secondChunk],
        ];
        const finalEntry: readonly [string, unknown] = [
          'values',
          { messages: finalMessages },
        ];
        const iterator = (async function* (): AsyncGenerator<
          readonly [string, unknown]
        > {
          await Promise.resolve();
          yield firstEntry;
          await Promise.resolve();
          yield secondEntry;
          await Promise.resolve();
          yield finalEntry;
        })();
        return Promise.resolve(iterator);
      },
    };

    const driver = createDriver(executor);
    const input: RunInput = {
      history: [],
      threadKey: 'thread-1',
      generatedFromIndex: 0,
      useCheckpointer: false,
    };

    const collected: GraphStreamChunk[] = [];
    for await (const chunk of driver.stream(input)) {
      collected.push(chunk);
    }

    const deltaEvents = collected.filter(
      (chunk): chunk is { type: 'delta'; text: string } =>
        'type' in chunk && chunk.type === 'delta',
    );
    expect(deltaEvents.map((event) => event.text)).toEqual(['Hello', ' world']);

    const toolEvent = collected.find(
      (chunk) => 'type' in chunk && chunk.type === 'tool',
    );
    expect(toolEvent).toEqual({
      type: 'tool',
      name: 'lookup',
      args: { query: 'weather' },
    });

    const internal = collected.find(
      (chunk) => 'kind' in chunk && chunk.kind === 'internal',
    );
    expect(internal).toEqual({
      kind: 'internal',
      messages: finalMessages,
    });
  });
});
