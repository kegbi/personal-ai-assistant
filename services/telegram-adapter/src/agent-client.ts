import {
  AgentResponsePayload,
  AgentStreamEvent,
  AgentResponseMeta,
  MessageReceivedPayload,
} from './types';

export interface AgentClientOptions {
  timeoutMs: number;
  authToken?: string;
}

export class AgentClient {
  private readonly eventsUrl: string;
  private readonly eventsStreamUrl: string;
  private readonly timeoutMs: number;
  private readonly authToken?: string;

  constructor(baseUrl: string, options: AgentClientOptions) {
    this.eventsUrl = new URL('/events', baseUrl).toString();
    this.eventsStreamUrl = new URL('/events/stream', baseUrl).toString();
    this.timeoutMs = options.timeoutMs;
    this.authToken = options.authToken;
  }

  async sendMessage(payload: MessageReceivedPayload): Promise<AgentResponsePayload> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };

    if (this.authToken) {
      headers.authorization = `Bearer ${this.authToken}`;
    }

    const signal = AbortSignal.timeout(this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(this.eventsUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new Error(`Agent request timed out after ${this.timeoutMs}ms`);
      }
      throw new Error(`Failed to call agent server: ${(error as Error).message}`);
    }

    if (!response.ok) {
      const body = await safeReadBody(response);
      throw new Error(
        `Agent server responded with ${response.status} ${response.statusText}: ${body}`,
      );
    }

    return (await response.json()) as AgentResponsePayload;
  }

  async *sendMessageStream(
    payload: MessageReceivedPayload,
  ): AsyncGenerator<AgentStreamEvent> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/x-ndjson',
    };

    if (this.authToken) {
      headers.authorization = `Bearer ${this.authToken}`;
    }

    const signal = AbortSignal.timeout(this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(this.eventsStreamUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new Error(
          `Agent streaming request timed out after ${this.timeoutMs}ms`,
        );
      }
      throw new Error(
        `Failed to stream from agent server: ${(error as Error).message}`,
      );
    }

    if (!response.ok) {
      const body = await safeReadBody(response);
      throw new Error(
        `Agent server responded with ${response.status} ${response.statusText}: ${body}`,
      );
    }

    if (!response.body) {
      const text = await response.text();
      for (const event of this.parseBufferedStream(text)) {
        yield event;
      }
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        if (value) {
          buffer += decoder.decode(value, { stream: true });
        }

        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line.length > 0) {
            const event = this.parseStreamLine(line);
            if (event) {
              yield event;
            }
          }
          newlineIndex = buffer.indexOf('\n');
        }
      }

      const remaining = buffer.trim();
      if (remaining.length > 0) {
        const finalEvent = this.parseStreamLine(remaining);
        if (finalEvent) {
          yield finalEvent;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private parseBufferedStream(text: string): AgentStreamEvent[] {
    const events: AgentStreamEvent[] = [];
    const lines = text.split('\n');

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.length === 0) {
        continue;
      }
      const event = this.parseStreamLine(line);
      if (event) {
        events.push(event);
      }
    }

    return events;
  }

  private parseStreamLine(line: string): AgentStreamEvent | null {
    let payload: unknown;

    try {
      payload = JSON.parse(line);
    } catch {
      return null;
    }

    if (!this.isRecord(payload)) {
      return null;
    }

    const type = payload.type;
    if (type === 'start') {
      return { type: 'start' };
    }

    if (type === 'delta' && typeof payload.text === 'string') {
      return { type: 'delta', text: payload.text };
    }

    if (type === 'tool') {
      const name = payload.name;
      if (typeof name !== 'string' || name.length === 0) {
        return null;
      }
      const args = payload.args;
      if (!this.isRecord(args)) {
        return null;
      }
      return {
        type: 'tool',
        name,
        args,
      };
    }

    if (type === 'final' && typeof payload.text === 'string') {
      const meta = this.parseAgentResponseMeta(payload.meta);
      return {
        type: 'final',
        text: payload.text,
        meta,
      };
    }

    if (type === 'error' && typeof payload.message === 'string') {
      return {
        type: 'error',
        message: payload.message,
      };
    }

    return null;
  }

  private parseAgentResponseMeta(
    value: unknown,
  ): AgentResponseMeta | undefined {
    if (!this.isRecord(value)) {
      return undefined;
    }

    const meta: AgentResponseMeta = {};
    const tool = value.tool;
    if (typeof tool === 'string' && tool.length > 0) {
      meta.tool = tool;
    }

    const args = value.args;
    if (this.isRecord(args)) {
      meta.args = args;
    }

    const elapsedMs = value.elapsedMs;
    if (typeof elapsedMs === 'number' && Number.isFinite(elapsedMs)) {
      meta.elapsedMs = elapsedMs;
    }

    if (
      meta.tool === undefined &&
      meta.args === undefined &&
      meta.elapsedMs === undefined
    ) {
      return undefined;
    }

    return meta;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
    );
  }
}

const safeReadBody = async (response: Response): Promise<string> => {
  try {
    const text = await response.text();
    return text.slice(0, 500);
  } catch (error) {
    return `<failed to read body: ${(error as Error).message}>`;
  }
};
