import type { MessageContent } from '@langchain/core/messages';

interface TextSegmentCandidate {
  readonly type?: unknown;
  readonly text?: unknown;
}

/**
 * Converts LangChain message content payloads into plain text strings.
 */
export class TextExtractor {
  /**
   * Extracts concatenated text from content segments, ignoring non-text entries.
   *
   * @param content Message content provided by LangGraph during streaming.
   * @returns Aggregated text from all text segments in the payload.
   */
  extract(content: MessageContent): string {
    if (typeof content === 'string') {
      return content;
    }

    const segments: string[] = [];
    for (const segment of content) {
      if (!this.isTextCandidate(segment)) {
        continue;
      }

      const typeValue = segment.type;
      if (typeValue === 'text') {
        const textValue = segment.text;
        if (typeof textValue === 'string') {
          segments.push(textValue);
        }
      }
    }

    return segments.join('');
  }

  private isTextCandidate(value: unknown): value is TextSegmentCandidate {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
