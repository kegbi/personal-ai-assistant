export interface MessageReceivedPayload {
  chatId: string;
  userId: string;
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

export interface BridgeStatus {
  ok: boolean;
  startedAt: string;
  lastUpdateAt?: string;
  lastAgentInteractionAt?: string;
  lastAgentError?: string;
  processedUpdates: number;
}
