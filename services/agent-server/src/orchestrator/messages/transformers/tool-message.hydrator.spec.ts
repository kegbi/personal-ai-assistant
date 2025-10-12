import { SystemMessage, ToolMessage } from '@langchain/core/messages';
import { ToolMessageHydrator } from './tool-message.hydrator';

describe('ToolMessageHydrator', () => {
  const hydrator = new ToolMessageHydrator();

  it('rehydrates tool messages from metadata', () => {
    const meta = {
      toolCallId: 'call-1',
      tool: 'search',
      additional_kwargs: { unit: 'metric' },
    };

    const result = hydrator.rehydrate('payload', meta);

    expect(result).toBeInstanceOf(ToolMessage);
    expect(result?.tool_call_id).toBe('call-1');
    expect(result?.additional_kwargs).toEqual({ unit: 'metric' });

    meta.additional_kwargs.unit = 'imperial';

    expect(result?.additional_kwargs).toEqual({ unit: 'metric' });
  });

  it('returns null when tool metadata is incomplete', () => {
    const result = hydrator.rehydrate('payload', { tool: 'search' });
    expect(result).toBeNull();
  });

  it('builds fallback metadata for orphaned tool responses', () => {
    const toolMessage = new ToolMessage({
      content: 'data',
      tool_call_id: 'tool-9',
      name: 'fetch',
      additional_kwargs: { status: 'ok' },
    });

    const fallbackMeta = hydrator.buildFallbackMeta(toolMessage);

    expect(fallbackMeta).toEqual({
      status: 'ok',
      tool: 'fetch',
      toolCallId: 'tool-9',
    });
  });

  it('detects legacy tool metadata records', () => {
    const looksLikeTool = hydrator.looksLikeLegacyToolMeta({
      tool_call_id: 'legacy-1',
    });

    expect(looksLikeTool).toBe(true);
  });

  it('extracts legacy content, falling back to provided value when missing', () => {
    const content = hydrator.extractLegacyToolContent('fallback', {
      content: 'legacy-content',
      tool_call_id: 'legacy-1',
    });

    expect(content).toBe('legacy-content');

    const fallback = hydrator.extractLegacyToolContent('fallback', undefined);
    expect(fallback).toBe('fallback');
  });

  it('creates system messages from raw tool content', () => {
    const systemMessage = hydrator.createSystemMessageFromRaw('text', {
      origin: 'tool',
    });

    expect(systemMessage).toBeInstanceOf(SystemMessage);
    expect(systemMessage.additional_kwargs).toEqual({ origin: 'tool' });
  });
});
