import type { MessageContent } from '@langchain/core/messages';
import { TextExtractor } from './text-extractor';

describe('TextExtractor', () => {
  it('returns string content unchanged', () => {
    const extractor = new TextExtractor();
    const content: MessageContent = 'hello';
    expect(extractor.extract(content)).toBe('hello');
  });

  it('concatenates multiple text segments', () => {
    const extractor = new TextExtractor();
    const content: MessageContent = [
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ' world' },
    ];
    expect(extractor.extract(content)).toBe('Hello world');
  });

  it('ignores non-text segments within structured content', () => {
    const extractor = new TextExtractor();
    const content: MessageContent = [
      { type: 'image_url', url: 'http://example.test' },
      { type: 'text', text: 'Kept' },
      { type: 'audio', audio: 'ignored' },
    ];
    expect(extractor.extract(content)).toBe('Kept');
  });
});
