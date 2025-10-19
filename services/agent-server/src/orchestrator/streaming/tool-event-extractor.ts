import type { AIMessage } from '@langchain/core/messages';
import type { AgentStreamEvent } from '../../transport/dto/agent-stream-event.dto';

interface ToolCallCandidate {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly args?: unknown;
}

/**
 * Emits unique tool stream events derived from AI message tool calls.
 */
export class ToolEventExtractor {
  private readonly emitted = new Set<string>();

  /**
   * Extracts tool events from a streamed AI message while preventing duplicates.
   *
   * @param message AI message chunk received from LangGraph.
   * @returns Collection of tool stream events to forward to the client.
   */
  extract(message: AIMessage): AgentStreamEvent[] {
    const events: AgentStreamEvent[] = [];
    const rawCalls = Reflect.get(message, 'tool_calls');
    if (!Array.isArray(rawCalls)) {
      return events;
    }

    for (let index = 0; index < rawCalls.length; index += 1) {
      const call = rawCalls[index];
      if (!this.isToolCallCandidate(call)) {
        continue;
      }

      const name = call.name;
      if (typeof name !== 'string' || name.length === 0) {
        continue;
      }

      const callId = this.resolveCallId(call.id, message.id, index);
      if (this.emitted.has(callId)) {
        continue;
      }

      const args = this.normalizeArgs(call.args);
      if (args === null) {
        continue;
      }

      this.emitted.add(callId);
      events.push({
        type: 'tool',
        name,
        args,
      });
    }

    return events;
  }

  private resolveCallId(
    idValue: unknown,
    messageId: unknown,
    index: number,
  ): string {
    if (typeof idValue === 'string' && idValue.length > 0) {
      return idValue;
    }

    if (typeof messageId === 'string' && messageId.length > 0) {
      return `${messageId}:${index}`;
    }

    return `tool:${index}`;
  }

  private normalizeArgs(args: unknown): Record<string, unknown> | null {
    if (this.isRecord(args)) {
      return this.cloneRecord(args);
    }

    if (typeof args === 'string') {
      try {
        const parsed = this.parseJson(args);
        if (this.isRecord(parsed)) {
          return this.cloneRecord(parsed);
        }
      } catch {
        return null;
      }
    }

    return null;
  }

  private isToolCallCandidate(value: unknown): value is ToolCallCandidate {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
    const entries: Array<[string, unknown]> = [];
    for (const key of Object.keys(value)) {
      const entry = Reflect.get(value, key);
      entries.push([key, this.cloneValue(entry)]);
    }
    return Object.fromEntries(entries);
  }

  private cloneValue(value: unknown): unknown {
    if (this.isRecord(value)) {
      return this.cloneRecord(value);
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.cloneValue(item));
    }

    return value;
  }

  private parseJson(text: string): unknown {
    return JSON.parse(text);
  }
}
