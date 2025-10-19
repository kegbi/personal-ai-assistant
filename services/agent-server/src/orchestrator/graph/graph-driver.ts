import type { BaseMessage } from '@langchain/core/messages';
import type { AgentStreamEvent } from '../../transport/dto/agent-stream-event.dto';

/**
 * Input details required to execute a LangGraph run.
 */
export interface RunInput {
  readonly history: BaseMessage[];
  readonly threadKey: string;
  readonly generatedFromIndex: number;
  readonly useCheckpointer: boolean;
}

/**
 * Result payload returned by a LangGraph run invocation.
 */
export interface RunResult {
  readonly transcript: BaseMessage[];
  readonly generatedFromIndex: number;
  readonly elapsedMs: number;
}

/**
 * Internal stream chunk emitted by the driver for downstream orchestration.
 */
export interface GraphInternalChunk {
  readonly kind: 'internal';
  readonly messages?: BaseMessage[];
}

export type GraphStreamChunk = AgentStreamEvent | GraphInternalChunk;

/**
 * Driver responsible for executing LangGraph runs and translating stream entries.
 */
export interface GraphDriver {
  /**
   * Executes LangGraph synchronously and returns the resulting transcript.
   *
   * @param input Parameters controlling the run execution.
   * @returns Transcript details including elapsed time.
   */
  run(input: RunInput): Promise<RunResult>;

  /**
   * Streams LangGraph output as transport-friendly events.
   *
   * @param input Parameters controlling the stream execution.
   * @returns Async generator emitting stream events and internal updates.
   */
  stream(input: RunInput): AsyncGenerator<GraphStreamChunk>;
}

export const GRAPH_DRIVER = Symbol('GRAPH_DRIVER');
