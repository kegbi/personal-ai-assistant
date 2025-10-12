import { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages/tool';
import type { MemoryMessage } from '../../../memory/memory.service';
import { AssistantMessageHydrator } from './assistant-message.hydrator';

describe('AssistantMessageHydrator', () => {
  const hydrator = new AssistantMessageHydrator();

  it('rehydrates assistant messages with sanitized metadata', () => {
    const toolCalls: ToolCall[] = [
      {
        name: 'lookup',
        args: { query: 'alice' },
        id: 'call-1',
      },
    ];

    const memoryMessage: MemoryMessage = {
      role: 'assistant',
      content: 'Alice lives in London.',
      meta: {
        tool_calls: toolCalls,
        response_metadata: { latencyMs: 42 },
        irrelevant: 'keep-me',
      },
      toolCalls,
    };

    const result = hydrator.rehydrate(
      memoryMessage.content ?? '',
      memoryMessage,
    );

    expect(result).toBeInstanceOf(AIMessage);
    expect(result.tool_calls).toEqual(toolCalls);
    expect(result.additional_kwargs).toEqual({
      irrelevant: 'keep-me',
    });
    expect(result.response_metadata).toEqual({ latencyMs: 42 });

    if (result.tool_calls) {
      result.tool_calls[0].name = 'mutated';
    }

    expect(toolCalls[0].name).toBe('lookup');
  });

  it('creates persistence metadata from assistant messages', () => {
    const toolCalls: ToolCall[] = [
      {
        name: 'remember',
        args: { contact: 'bob' },
        id: 'tool-1',
      },
    ];

    const message = new AIMessage({
      content: 'Stored contact.',
      additional_kwargs: { temperature: 0.2 },
      response_metadata: { latencyMs: 12 },
      tool_calls: toolCalls,
    });

    const meta = hydrator.buildPersistenceMeta(message, toolCalls);

    expect(meta).toEqual({
      temperature: 0.2,
      response_metadata: { latencyMs: 12 },
      tool_calls: toolCalls,
    });

    if (meta && Array.isArray(meta.tool_calls)) {
      expect(meta.tool_calls).not.toBe(toolCalls);
    }
  });

  it('detects persisted tool calls in memory messages', () => {
    const memoryMessage: MemoryMessage = {
      role: 'assistant',
      content: 'Done.',
      meta: {
        tool_calls: [
          {
            name: 'noop',
            args: {},
            id: 'id-1',
          },
        ],
      },
    };

    expect(hydrator.hasToolCalls(memoryMessage)).toBe(true);
  });

  it('matches tool responses against assistant tool calls', () => {
    const assistant = new AIMessage({
      content: 'Running lookup…',
      tool_calls: [
        {
          name: 'lookup',
          args: { query: 'charlie' },
          id: 'call-3',
        },
      ],
    });

    const toolResponse = new ToolMessage({
      content: 'Result',
      tool_call_id: 'call-3',
      name: 'lookup',
    });

    expect(hydrator.toolCallMatches(assistant, toolResponse)).toBe(true);
  });
});
