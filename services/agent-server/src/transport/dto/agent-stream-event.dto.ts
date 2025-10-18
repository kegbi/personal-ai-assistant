import type { AgentResponseMeta } from './agent-response.dto';

export interface AgentStreamStartEvent {
  readonly type: 'start';
}

export interface AgentStreamDeltaEvent {
  readonly type: 'delta';
  readonly text: string;
}

export interface AgentStreamToolEvent {
  readonly type: 'tool';
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface AgentStreamFinalEvent {
  readonly type: 'final';
  readonly text: string;
  readonly meta?: AgentResponseMeta;
}

export interface AgentStreamErrorEvent {
  readonly type: 'error';
  readonly message: string;
}

export type AgentStreamEvent =
  | AgentStreamStartEvent
  | AgentStreamDeltaEvent
  | AgentStreamToolEvent
  | AgentStreamFinalEvent
  | AgentStreamErrorEvent;
