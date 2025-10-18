export type MessagePayloadType = 'text' | 'voice' | 'command' | 'other';

export interface MessageReceivedPayload {
  connectorId?: string;
  idempotencyKey?: string;
  chatId: string;
  userId: string;
  type: MessagePayloadType;
  text?: string;
  voiceUrl?: string;
  isCommand?: boolean;
  command?: string;
  payload?: Record<string, unknown>;
}

export interface AgentResponseMeta {
  tool?: string;
  args?: Record<string, unknown>;
  elapsedMs?: number;
}

export interface AgentResponsePayload {
  chatId: string;
  text: string;
  meta?: AgentResponseMeta;
}

export type StreamingMode = 'disabled' | 'edit';

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

export interface BridgeStatus {
  ok: boolean;
  startedAt: string;
  lastUpdateAt?: string;
  lastAgentInteractionAt?: string;
  lastAgentError?: string;
  processedUpdates: number;
}
