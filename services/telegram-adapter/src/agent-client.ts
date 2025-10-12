import { AgentResponsePayload, MessageReceivedPayload } from './types';

export interface AgentClientOptions {
  timeoutMs: number;
  authToken?: string;
}

export class AgentClient {
  private readonly eventsUrl: string;
  private readonly timeoutMs: number;
  private readonly authToken?: string;

  constructor(baseUrl: string, options: AgentClientOptions) {
    this.eventsUrl = new URL('/events', baseUrl).toString();
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
}

const safeReadBody = async (response: Response): Promise<string> => {
  try {
    const text = await response.text();
    return text.slice(0, 500);
  } catch (error) {
    return `<failed to read body: ${(error as Error).message}>`;
  }
};
