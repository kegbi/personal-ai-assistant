# Plan 1 Task Breakdown

## Step 1 – Extract Pure Streaming Helpers
- [x] Introduce `TextExtractor` class for `MessageContent` to text conversion.
- [x] Add `DeltaAccumulator` to calculate incremental assistant deltas.
- [x] Implement `ToolEventExtractor` to deduplicate tool hint emissions.
- [x] Cover all helpers with focused unit tests.
- [x] Replace inline helper logic in `orchestrator.service.ts` with the new classes.

## Step 2 – Introduce GraphDriver Abstraction
- [x] Define `GraphDriver` interface plus supporting types for run/stream flows.
- [x] Implement `DefaultGraphDriver` encapsulating LangGraph invoke/stream logic.
- [x] Add targeted tests validating run and stream behaviour for the driver.
- [x] Update orchestrator code to consume `GraphDriver` instead of direct graph access.

## Step 3 – Extract Conversation Store and Transcript Assembler
- [x] Create `ConversationStore` to encapsulate memory reads and writes.
- [x] Add `TranscriptAssembler` to build histories and generated indices.
- [x] Add unit tests for the new services covering memory and history assembly.
- [x] Wire `ConversationStore` and `TranscriptAssembler` into `OrchestratorService`.

## Step 4 – Extract Persistence and Response Composition
- [ ] Introduce `TranscriptPersister` wrapping generated message persistence.
- [ ] Add `ResponseComposer` to delegate response construction to `ResponseBuilder`.
- [ ] Provide unit tests ensuring persistence slicing and response mapping.
- [ ] Update orchestrator flow to use the new services.

## Step 5 – Introduce ConversationOrchestrator Façade
- [ ] Implement `ConversationOrchestrator` for non-command run and stream execution.
- [ ] Ensure façade coordinates helpers, persistence, and graph driver correctly.
- [ ] Add unit/integration-style tests for handle/handleStream paths.
- [ ] Delegate from `OrchestratorService` to the new façade while retaining spans/logging.
