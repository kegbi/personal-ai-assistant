Roadmap overview

Guiding goals: decouple transport from server, shrink orchestrator, add idempotency and security at the ingress, make tools robust to real-world inputs, and adopt LangGraph checkpointer so you stop replaying history. Everything else (streaming, multi-connector, observability) builds on that.
Delivery style: small, safe PRs with production toggles. Each stage targets 0–1 major behavior change and can ship independently.
Stage 0 — Project prep and guardrails
Objective: Make changes safe to ship incrementally.
Key changes

Add a feature flag object in config (e.g., ENABLE_CHECKPOINTER, ENABLE_STREAMING, ENABLE_IDEMPOTENCY).
Introduce threadKey helper now (connectorId:chatId) but don’t switch memory keys yet.
Add correlationId middleware and structured logs (include threadKey, updateId/idempotencyKey).
Ensure CI runs tests and lints for both server and adapter; enable basic e2e smoke hitting /health. Acceptance criteria
Logs include correlationId and, when available, a provisional threadKey.
CI green, repo has CONTRIBUTING.md + PR checklist. Estimate: 0.5–1 day
Stage 1 — Secure transport boundary (EventsController + token auth)
Objective: Create the explicit HTTP boundary the Telegram adapter calls; protect it.
Key changes

Server: add POST /events (EventsController) that accepts a normalized, transport-agnostic DTO (connectorId, chatId, userId, type, text, voiceUrl, payload, idempotencyKey).
Add a BearerGuard that validates Authorization: Bearer <AGENT_AUTH_TOKEN>.
Adapter: already supports auth token in AgentClient; add idempotencyKey=update.update_id to the payload.
docker-compose: put both services on an internal network; no public port for server. Acceptance criteria
Unauthorized requests to /events are 401; authorized requests reach Orchestrator.
Adapter successfully posts messages; local manual test flows work as before. Estimate: 0.5–1 day Risks/notes
Don’t remove old paths until the adapter is switched. Rollback is trivial (revert controller + guard).
Stage 2 — Idempotency at ingress
Objective: Prevent duplicate processing and duplicate writes.
Key changes

Implement DedupeService using Redis SET key with NX + EX (idemp:<threadKey>:<idempotencyKey>).
Orchestrator: short-circuit when duplicate; reply with a minimal “duplicate ignored” or simply no-op depending on adapter expectations. Acceptance criteria
Replaying the same Telegram update (same idempotencyKey) does not create duplicate memory messages or calls to Monica.
Unit test for DedupeService and e2e happy path with two identical updates. Estimate: 0.5 day
Stage 3 — Orchestrator split (purify responsibilities)
Objective: Shrink Orchestrator to routing only.
Key changes

Extract CommandRouter (handles /start, /help, /clear).
Extract ResponseBuilder (turn final AIMessage + toolMeta into the response DTO).
Extract InputNormalizer (server fallback): pure function converting NormalizedEvent into text for storage (“[voice …]”, etc.) — actual normalization still primarily happens in adapters.
Orchestrator now: dedupe → route command or LLM → persist generated messages → build response. Acceptance criteria
Orchestrator no longer mentions voiceUrl or Telegram specifics.
Unit tests for CommandRouter and ResponseBuilder pass. Estimate: 1–2 days
Stage 4 — Memory namespacing (threadKey) with safe migration
Objective: Prevent collisions as you add connectors; prepare for checkpointer.
Key changes

MemoryService: change methods to accept threadKey (or overload to support chatId for transition).
Configure threadKey = ${connectorId}:${chatId} and pass it everywhere (generatedMessages, handles).
One-time migration: for existing Redis window keys, SCAN memory:window:* and rename to include a default connector prefix (e.g., tg:). Provide a migration script guarded behind an env flag. Acceptance criteria
New window and handle keys include connector prefix.
Old data either migrated or ignored without breaking current chats. Estimate: 1 day Risk
If you have existing prod memory you care about, run the rename script offline or in maintenance mode.
Stage 5 — Tool robustness: date normalization and basic contact lookup
Objective: Make tool calls reliable with real user inputs.
Key changes

Add a DatesService (parse with date-fns) to normalize common formats to ISO (yyyy-MM-dd). Use inside contacts_set_birthday and contacts_create (optional birthday).
Add contacts_find_by_name tool that returns candidates with ids; use it when the user refers to names without ids. Keep last_contact_id handle as a convenience, but don’t rely on it exclusively.
Keep zod schemas permissive for dates; do the real coercion/validation inside the tool. Acceptance criteria
“Assign DOB to contact A as 14.05.1991” succeeds; tool persists ISO.
“Set Bob birthday to 1991/5/2” succeeds.
“Set Alice’s birthday to …” without id triggers find_by_name → set_birthday flow. Estimate: 1–2 days
Stage 6 — Checkpointer adoption (stop replaying history)
Objective: Persist graph state and resume runs per thread; reduce latency and complexity.
Key changes

GraphFactory.compile({ checkpointer: MemorySaver initially }); pass thread_id in config.configurable; use configurable.chatId = threadKey consistently.
Orchestrator: stop rebuilding history via HistoryBuilder; invoke graph with empty messages (the checkpointer resumes state). Keep the old path behind a feature flag to fall back if needed.
Generated message persistence: leave as-is for now (useful for audits/replies), but mark it as optional going forward. Acceptance criteria
With ENABLE_CHECKPOINTER=true, runs produce the same user-visible behavior, with lower CPU/memory as the window grows.
Quick load test: 50-message thread doesn’t degrade linearly vs the previous replay approach. Estimate: 2–3 days Risk/notes
Verify the exact checkpointer API in your installed @langchain/langgraph version; if APIs moved, swap MemorySaver for the recommended saver backend you plan to keep (Redis/Postgres). Keep the feature flag to revert.
Stage 7 — Monica client hardening and reminder caching
Objective: Reduce flakiness and latency.
Key changes

MonicaClient: add per-request timeout via AbortController; classify errors (4xx vs 5xx/429), add simple retries with exponential backoff for 5xx/429.
RemindersService: cache fetchAllReminders() in Redis for a short TTL (e.g., 60–180 seconds). Tool reminders_get_upcoming returns cached data when valid. Acceptance criteria
Transient Monica outages don’t crash the run; you get a brief user-facing error with retry hint.
Reminders digest is fast when called multiple times in a short window. Estimate: 1–1.5 days
Stage 8 — Observability (structured logs and traces)
Objective: Make runs diagnosable in production.
Key changes

Replace default Nest logger with pino or keep Nest but add a pino-like structure via interceptor. Ensure each log line includes correlationId (per-request) and threadKey.
Optional: Add OpenTelemetry traces around /events → Orchestrator → Graph invocation → tools; export to stdout or simple collector. Acceptance criteria
One-click search of a run across services using correlationId.
Basic timings visible for tool calls and graph steps. Estimate: 1–2 days
Stage 9 — Streaming and better UX in adapter
Objective: Faster perceived responses.
Key changes

Server: expose a streaming mode from GraphRunner using graph.stream (values or messages). For Telegram, you can still proxy as a single final message but update a placeholder via message edits if you wish.
Adapter: sendChatAction('typing') while awaiting; optionally post a placeholder message and edit as chunks arrive (keep off by default). Acceptance criteria
For long answers, user sees typing/placeholder; final text delivered. Toggle via env. Estimate: 2 days (split between server and adapter) Risk
Telegram rate limits on edits; batch updates conservatively (e.g., 300–500ms).
Stage 10 — Security and ops hardening
Objective: Production posture improvements.
Key changes

Redis: allow password/TLS config; don’t expose outside the network.
Add rate limits on /events (per connectorId/chatId).
Docker: install prod deps only in runtime images; add HEALTHCHECK; reduce image size; pin Node LTS you require. Acceptance criteria
HEALTHCHECK for both services returns healthy.
Redis credentials configurable; containers run as non-root (already done). Estimate: 1 day
Stage 11 — Multi-connector readiness
Objective: Make swapping connectors trivial; prepare for Matrix/Web.
Key changes

Formalize NormalizedEventDto and version it (v1) in a shared package or a /contracts folder the adapters can import.
Introduce a tiny identity map (optional): principalId = mapping(connectorId, userId) if you ever need cross-channel continuity.
Provide a sample Matrix/Web adapter skeleton (same DTO, same auth). Acceptance criteria
A second “mock” adapter (or CLI) can send /events and get correct replies without any code changes server-side. Estimate: 1–2 days
Stage 12 — Long-term memory and (optional) vector memory
Objective: Persist durable knowledge beyond short-term thread state.
Key changes

Decide on durable store (Postgres) for “facts” and notes separate from Monica (or keep Monica as SoR).
Optional: introduce a vector store for semantic recall; keep it out of the hot path unless required. Acceptance criteria
You can persist/retrieve durable facts across restarts without relying on windowed Redis history. Estimate: 3–5 days (if you choose to do it now)
Release plan and PR slicing

One PR per stage (max ~300–500 LOC diff where possible).
Keep feature flags for any behavioral switch (ENABLE_CHECKPOINTER, ENABLE_STREAMING, ENABLE_IDEMPOTENCY).
Every PR updates a CHANGELOG and operational notes.
Definition of done (per stage)

Code merged, unit tests added/updated, end-to-end smoke verified locally.
Rollback plan: feature flag or revertable change.
Operational notes: env var changes, migrations steps (if any), dashboards/logs screenshots (when applicable).
Testing plan by layer

Unit: DedupeService, DatesService, ToolRouterNode error paths, MessageTransformer edge cases (already good coverage, extend as you add features).
Integration: Orchestrator + GraphRunner happy path; EventsController auth + validation; MonicaClient backoff (mock fetch).
E2E: Adapter → Server (docker-compose) script that sends a few messages (text, command, voice placeholder), asserts Telegram receive or logs.
Operational metrics to watch post‑deploy

P50/P95 time from adapter forward to response send.
Graph steps per run (should flatten with checkpointer).
Tool failure rate and retries.
Duplicate suppression count (to validate idempotency).
Redis memory usage and key cardinality after namespacing.
What you can do in parallel

Stages 1–2–3 are mostly server changes and can ship quickly.
Stage 5 (tool robustness) can be parallel to Stage 3.
Stage 7 (Monica hardening) can be parallel to Stage 6.
Stage 8 (observability) can start anytime.
Quick task list (copy into an issue tracker)

S0: Flags + correlationId in logs + CI smoke
S1: /events + BearerGuard + adapter idempotencyKey
S2: DedupeService + short-circuit on dupes
S3: CommandRouter + ResponseBuilder + InputNormalizer extracted
S4: ThreadKey everywhere + Redis migration script
S5: DatesService + contacts_find_by_name + tool updates
S6: Graph checkpointer + feature flag + kill history replay path
S7: Monica timeouts/retries + reminders cache
S8: Pino logs + optional OTEL traces
S9: Streaming interface + Telegram typing/edit flow
S10: Redis TLS/password + HEALTHCHECK + rate limiting
S11: Normalize contract package + mock second adapter
S12: Durable memory store planning (optional)
Estimated timeline (conservative)

Week 1: S1–S4
Week 2: S5–S7
Week 3: S8–S10
Week 4+: S11–S12 as needed