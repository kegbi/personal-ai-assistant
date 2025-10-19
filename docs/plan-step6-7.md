# Step 6 & 7 Execution Notes

This brief supplements the main refactor plan once Steps 1–5 are complete.

## Step 6 – DI Wiring and Cleanup

### Tasks
- [x] Verify `GRAPH_DRIVER` provider in `orchestrator.module.ts` builds `DefaultGraphDriver` via factory and uses existing `GraphFactory`.
- [x] Audit consumers to ensure `ConversationOrchestrator` injects `GRAPH_DRIVER` and `OrchestratorService` never constructs drivers directly.
- [x] Review orchestrator-related services for superseded helpers or fields; delete or refactor any no-longer-used logic.
- [x] Update unit tests if wiring changes affect setup (no changes required after audit).

### Acceptance
- [x] No direct `new DefaultGraphDriver` usage outside DI/test scaffolding.
- [x] Removed helpers are covered by existing services with tests updated as needed.
- [x] Lint, build, and test suites succeed after changes.

## Step 7 – CheckpointerStrategy Scaffolding

### Tasks
- [x] Define `CheckpointerStrategy` interface and token (`graph/checkpointer-strategy.ts`) exposing `isEnabled()`.
- [x] Update `GraphFactory` to accept an optional strategy injection and fall back to config-driven flag when absent.
- [x] Register the strategy token in the LangGraph DI wiring so future implementations can override it without touching the factory.
- [x] Refresh unit specs or helpers if constructor signatures shift (none required after verification).

### Acceptance
- [x] GraphFactory behaviour matches current logic when no external strategy is provided.
- [x] Optional provider hook is available for custom checkpointer strategies.
- [x] Lint, build, and test suites succeed with no regressions.
