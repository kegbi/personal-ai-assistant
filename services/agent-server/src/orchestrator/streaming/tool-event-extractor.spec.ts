import { AIMessage } from '@langchain/core/messages';
import { ToolEventExtractor } from './tool-event-extractor';

describe('ToolEventExtractor', () => {
  it('emits events for tool calls with structured arguments', () => {
    const extractor = new ToolEventExtractor();
    const message = new AIMessage({
      content: '',
      tool_calls: [
        { id: 'call-1', name: 'lookup', args: { query: 'weather' } },
        { id: 'call-2', name: 'math', args: '{"value":42}' },
      ],
    });

    const events = extractor.extract(message);

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: 'tool',
      name: 'lookup',
      args: { query: 'weather' },
    });
    expect(events[1]).toEqual({
      type: 'tool',
      name: 'math',
      args: { value: 42 },
    });
  });

  it('deduplicates tool calls by identifier across invocations', () => {
    const extractor = new ToolEventExtractor();
    const firstMessage = new AIMessage({
      content: '',
      id: 'msg-1',
      tool_calls: [{ id: 'call-1', name: 'lookup', args: { query: 'once' } }],
    });
    extractor.extract(firstMessage);

    const secondMessage = new AIMessage({
      content: '',
      id: 'msg-1',
      tool_calls: [{ id: 'call-1', name: 'lookup', args: { query: 'again' } }],
    });

    const events = extractor.extract(secondMessage);
    expect(events).toHaveLength(0);
  });
});
