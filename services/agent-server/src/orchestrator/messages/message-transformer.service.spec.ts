import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { AssistantMessageHydrator } from './transformers/assistant-message.hydrator';
import { ToolMessageHydrator } from './transformers/tool-message.hydrator';
import { MessageTransformerService } from './message-transformer.service';
import type { MemoryMessage } from '../../memory/memory.service';

describe('MessageTransformerService', () => {
  const transformer = new MessageTransformerService(
    new AssistantMessageHydrator(),
    new ToolMessageHydrator(),
  );

  it('converts user memory messages into human messages', () => {
    const memoryMessage: MemoryMessage = {
      role: 'user',
      content: 'Hello',
      meta: { tone: 'friendly' },
    };

    const message = transformer.toBaseMessage(memoryMessage);

    expect(message).toBeInstanceOf(HumanMessage);
    expect(message.additional_kwargs).toEqual({ tone: 'friendly' });
  });

  it('rehydrates tool memory messages when identifiers are available', () => {
    const memoryMessage: MemoryMessage = {
      role: 'tool',
      content: 'Tool result',
      meta: {
        toolCallId: 'tool-1',
        tool: 'fetch',
      },
    };

    const message = transformer.toBaseMessage(memoryMessage);

    expect(message).toBeInstanceOf(ToolMessage);
    if (message instanceof ToolMessage) {
      expect(message.tool_call_id).toBe('tool-1');
    }
  });

  it('falls back to a system message when tool identifiers are missing', () => {
    const memoryMessage: MemoryMessage = {
      role: 'tool',
      content: 'No id provided',
      meta: {
        tool: 'fetch',
      },
    };

    const message = transformer.toBaseMessage(memoryMessage);

    expect(message).toBeInstanceOf(SystemMessage);
  });

  it('serializes AI messages for persistence', () => {
    const aiMessage = new AIMessage({
      content: 'Here is what I found.',
      tool_calls: [
        {
          name: 'lookup',
          args: { query: 'desk' },
          id: 'tool-2',
        },
      ],
      additional_kwargs: { temperature: 0 },
    });

    const memory = transformer.fromBaseMessage(aiMessage);

    expect(memory).not.toBeNull();
    expect(memory?.role).toBe('assistant');
    expect(memory?.meta).toEqual({
      temperature: 0,
      tool_calls: [
        {
          name: 'lookup',
          args: { query: 'desk' },
          id: 'tool-2',
        },
      ],
    });
    expect(memory?.toolCalls?.[0].id).toBe('tool-2');
  });

  it('extracts plain text from structured messages', () => {
    const toolMessage = new ToolMessage({
      content: ['Summary', { text: 'Details' }, { data: { nested: true } }],
      tool_call_id: 'id-4',
      name: 'tool',
    });

    const content = transformer.extractMessageContent(toolMessage);

    expect(content).toBe(
      ['Summary', 'Details', JSON.stringify({ data: { nested: true } })].join(
        '\n',
      ),
    );
  });

  it('derives tool invocation metadata from transcripts', () => {
    const toolMessage = new ToolMessage({
      content: 'payload',
      tool_call_id: 'call-9',
      name: 'fetch',
      additional_kwargs: { cached: false },
    });

    const meta = transformer.extractToolMeta([toolMessage]);
    expect(meta).toEqual({
      name: 'fetch',
      args: { cached: false },
    });
  });

  it('creates fallback system messages for orphaned tool responses', () => {
    const toolMessage = new ToolMessage({
      content: 'payload',
      tool_call_id: 'call-11',
      name: 'fetch',
      additional_kwargs: { cached: true },
    });

    const fallback = transformer.createFallbackSystemMessage(toolMessage);

    expect(fallback).toBeInstanceOf(SystemMessage);
    expect(fallback.additional_kwargs).toEqual({
      cached: true,
      tool: 'fetch',
      toolCallId: 'call-11',
    });
  });
});
