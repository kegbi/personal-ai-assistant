import { Inject, Injectable } from '@nestjs/common';
import type { BaseMessage } from '@langchain/core/messages';
import type { NormalizedEventDto } from '../../api/transport/dto/normalized-event.dto';
import type { AgentResponseDto } from '../../transport/dto/agent-response.dto';
import type { AgentStreamEvent } from '../../transport/dto/agent-stream-event.dto';
import type {
  GraphDriver,
  GraphInternalChunk,
  GraphStreamChunk,
} from '../graph/graph-driver';
import { GRAPH_DRIVER } from '../graph/graph-driver';
import { ConversationStore } from './conversation-store';
import { TranscriptAssembler } from './transcript-assembler';
import { TranscriptPersister } from './transcript-persister';
import { ResponseComposer } from './response-composer';
import { InputNormalizer } from '../input-normalizer.service';

export interface ConversationHandleInput {
  readonly threadKey: string;
  readonly chatId: string;
  readonly event: NormalizedEventDto;
  readonly useCheckpointer: boolean;
}

export type ConversationMode = 'memory' | 'checkpointer';

export interface ConversationOutcome {
  readonly response: AgentResponseDto;
  readonly transcript: BaseMessage[];
  readonly generatedFromIndex: number;
  readonly elapsedMs: number;
  readonly mode: ConversationMode;
  readonly windowLength: number;
}

export interface ConversationStream {
  readonly events: AsyncGenerator<AgentStreamEvent>;
  readonly result: Promise<ConversationOutcome>;
}

/**
 * Coordinates the end-to-end execution of a non-command conversation path.
 */
@Injectable()
export class ConversationOrchestrator {
  constructor(
    private readonly store: ConversationStore,
    private readonly assembler: TranscriptAssembler,
    private readonly persister: TranscriptPersister,
    private readonly composer: ResponseComposer,
    @Inject(GRAPH_DRIVER) private readonly graph: GraphDriver,
    private readonly normalizer: InputNormalizer,
  ) {}

  /**
   * Handles a non-streaming conversation flow and returns the final outcome.
   */
  async handle(input: ConversationHandleInput): Promise<ConversationOutcome> {
    const { threadKey, chatId, event, useCheckpointer } = input;
    const userContent = this.normalizer.toText(event);

    if (useCheckpointer) {
      const assembly = this.assembler.buildForCheckpointer(userContent);
      const run = await this.graph.run({
        history: assembly.transcript,
        threadKey,
        generatedFromIndex: assembly.generatedFromIndex,
        useCheckpointer: true,
      });

      const response = this.composer.compose(
        chatId,
        run.transcript,
        run.generatedFromIndex,
        run.elapsedMs,
      );

      return {
        response,
        transcript: run.transcript,
        generatedFromIndex: run.generatedFromIndex,
        elapsedMs: run.elapsedMs,
        mode: 'checkpointer',
        windowLength: assembly.transcript.length,
      };
    }

    await this.store.appendUser(threadKey, event);
    const window = await this.store.loadWindow(threadKey);
    const assembly = this.assembler.buildFromWindow(window);

    const run = await this.graph.run({
      history: assembly.transcript,
      threadKey,
      generatedFromIndex: assembly.generatedFromIndex,
      useCheckpointer: false,
    });

    await this.persister.persist(
      threadKey,
      run.transcript,
      run.generatedFromIndex,
    );

    const response = this.composer.compose(
      chatId,
      run.transcript,
      run.generatedFromIndex,
      run.elapsedMs,
    );

    return {
      response,
      transcript: run.transcript,
      generatedFromIndex: run.generatedFromIndex,
      elapsedMs: run.elapsedMs,
      mode: 'memory',
      windowLength: window.length,
    };
  }

  /**
   * Handles a streaming conversation flow.
   */
  stream(input: ConversationHandleInput): ConversationStream {
    const { threadKey, chatId, event, useCheckpointer } = input;
    const userContent = this.normalizer.toText(event);
    const mode: ConversationMode = useCheckpointer ? 'checkpointer' : 'memory';
    const startedAt = Date.now();

    let history: BaseMessage[] = [];
    let generatedFromIndex = 0;
    let windowLength = 0;

    const prepare = async (): Promise<void> => {
      if (useCheckpointer) {
        const assembly = this.assembler.buildForCheckpointer(userContent);
        history = assembly.transcript;
        generatedFromIndex = assembly.generatedFromIndex;
        windowLength = assembly.transcript.length;
        return;
      }

      await this.store.appendUser(threadKey, event);
      const window = await this.store.loadWindow(threadKey);
      windowLength = window.length;
      const assembly = this.assembler.buildFromWindow(window);
      history = assembly.transcript;
      generatedFromIndex = assembly.generatedFromIndex;
    };

    let resolveOutcome: (value: ConversationOutcome) => void = () => undefined;
    let rejectOutcome: (reason?: unknown) => void = () => undefined;
    const resultPromise = new Promise<ConversationOutcome>(
      (resolve, reject) => {
        resolveOutcome = resolve;
        rejectOutcome = reject;
      },
    );

    const events = (async function* (
      orchestrator: ConversationOrchestrator,
    ): AsyncGenerator<AgentStreamEvent> {
      await prepare();

      let finalMessages: BaseMessage[] | undefined;

      try {
        const stream = orchestrator.graph.stream({
          history,
          threadKey,
          generatedFromIndex,
          useCheckpointer,
        });

        for await (const chunk of stream) {
          if (ConversationOrchestrator.isInternalGraphChunk(chunk)) {
            if (Array.isArray(chunk.messages)) {
              finalMessages = chunk.messages;
            }
            continue;
          }

          if (ConversationOrchestrator.isAgentStreamEvent(chunk)) {
            yield chunk;
          }
        }

        const transcript = finalMessages ?? history;
        const elapsedMs = Date.now() - startedAt;

        if (!useCheckpointer) {
          await orchestrator.persister.persist(
            threadKey,
            transcript,
            generatedFromIndex,
          );
        }

        const response = orchestrator.composer.compose(
          chatId,
          transcript,
          useCheckpointer ? 0 : generatedFromIndex,
          elapsedMs,
        );

        resolveOutcome({
          response,
          transcript,
          generatedFromIndex: useCheckpointer ? 0 : generatedFromIndex,
          elapsedMs,
          mode,
          windowLength,
        });

        yield {
          type: 'final',
          text: response.text,
          meta: response.meta,
        };
      } catch (error) {
        rejectOutcome(error);
        throw error;
      }
    })(this);

    return {
      events,
      result: resultPromise,
    };
  }

  private static isInternalGraphChunk(
    chunk: GraphStreamChunk,
  ): chunk is GraphInternalChunk {
    return (
      typeof chunk === 'object' &&
      chunk !== null &&
      'kind' in chunk &&
      chunk.kind === 'internal'
    );
  }

  private static isAgentStreamEvent(
    chunk: GraphStreamChunk,
  ): chunk is AgentStreamEvent {
    return typeof chunk === 'object' && chunk !== null && 'type' in chunk;
  }
}
