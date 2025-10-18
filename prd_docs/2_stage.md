------------------------------------------------------------
Stage 5 PRD — Tool robustness (date normalization) and basic contact lookup

Objective
- Make tool calls resilient to real-world date formats.
- Add a contacts_find_by_name tool so the model can resolve contact IDs without relying only on last_contact_id.
- Update existing contacts_create and contacts_set_birthday tools to normalize dates to ISO (YYYY-MM-DD) internally.

In scope
- New DatesService for robust date parsing/normalization using date-fns.
- New tool: contacts_find_by_name.
- Update existing contacts tools to call DatesService for normalization (no schema change required; schema stays permissive).
- Prompt policy update to instruct the LLM to use the new tool and to rely on tool-side normalization.

Out of scope
- Streaming, checkpointer, or multi-connector changes.

Data contract changes
- No external API changes.
- Tool responses should be human-readable and contain stable identifiers; contacts_find_by_name returns a compact JSON in text form for the LLM to chain.

Files to add/change (server)

1) services/agent-server/src/tools/dates/dates.service.ts (NEW)
- Robust normalization of common formats to ISO.
- Accepts strings like 1991-05-14, 14.05.1991, 14-05-1991, 05/14/1991, 14/05/1991, 14 May 1991.

Code
import { Injectable } from '@nestjs/common';
import { format, isValid, parse } from 'date-fns';

// Order matters; try strict day-first before month-first to reduce ambiguity.
// You can tune this list for your locale.
const CANDIDATE_FORMATS = [
  'yyyy-MM-dd',
  'dd.MM.yyyy',
  'dd-MM-yyyy',
  'dd/MM/yyyy',
  'MM/dd/yyyy',
  'd MMM yyyy',
  'd MMMM yyyy',
  'yyyy/MM/dd',
];

@Injectable()
export class DatesService {
  normalizeToISO(input: string): string | null {
    const raw = (input ?? '').trim();
    if (!raw) return null;

    // Fast-path ISO
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

    for (const fmt of CANDIDATE_FORMATS) {
      const d = parse(raw, fmt, new Date());
      if (isValid(d)) {
        return format(d, 'yyyy-MM-dd');
      }
    }
    return null;
  }
}

2) services/agent-server/src/tools/tools.module.ts (ADD provider export)
- Register DatesService.

Code
import { Module } from '@nestjs/common';
import { DatesService } from './dates/dates.service';
// ... other providers

@Module({
  providers: [
    DatesService,
    // existing providers...
  ],
  exports: [
    DatesService,
    // existing exports...
  ],
})
export class ToolsModule {}

3) services/agent-server/src/orchestrator/langgraph/nodes/tool-router.node.ts (UPDATE)
- Add new tool contacts_find_by_name.
- Inject and use DatesService within contacts_create and contacts_set_birthday.
- Keep existing tool names and contracts; only enhance implementation.

Code (diff-style excerpts)
// imports
import { DatesService } from '../../../tools/dates/dates.service';

// in constructor
constructor(
  private readonly contactsService: ContactsService,
  private readonly memoryService: MemoryService,
  private readonly remindersService: RemindersService,
  private readonly datesService: DatesService, // NEW
) {
  this.tools = [
    // NEW: contacts_find_by_name
    tool(
      async ({ query, limit }, config) => {
        try {
          const threadKey = this.extractChatId(config);
          const results = await this.contactsService.searchContacts(threadKey, query, limit ?? 5);
          // Return a compact JSON text to help the LLM chain reliably
          // [{ id, name, birthday? }]
          const simplified = results.map((c: any) => ({
            id: c.id,
            name: c.name ?? c.complete_name ?? '[unnamed]',
            birthday: c.birthday ?? c.information?.dates?.birthdate?.date ?? null,
          }));
          return JSON.stringify(simplified);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          this.logger.warn(`contacts_find_by_name failed: ${reason}`);
          return '[]';
        }
      },
      {
        name: 'contacts_find_by_name',
        description:
          'Find existing contacts by a free-text name query. Use before updating a contact when only a name is given. Returns JSON array: [{ id, name, birthday? }].',
        schema: z.object({
          query: z.string().min(1, 'query is required'),
          limit: z.number().int().positive().max(20).optional(),
        }),
      },
    ),

    // EXISTING: contacts_create (enhanced with date normalization)
    tool(
      async ({ name, birthday, contactId }: CreateContactArgs, config) => {
        try {
          const threadKey = this.extractChatId(config);
          const iso = birthday ? this.datesService.normalizeToISO(birthday) : null;

          const contact = await this.contactsService.createContact(threadKey, {
            name,
            birthday: iso ?? undefined, // pass undefined if parsing failed
            id: contactId,
          });

          await this.memoryService.setHandle(threadKey, 'last_contact_id', contact.id);

          const bday = contact.birthday ?? (iso ? `${birthday} (normalized to ${iso})` : undefined);
          return `Saved contact ${contact.name} (id: ${contact.id})${bday ? ` – birthday ${bday}` : ''}.`;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          this.logger.warn(`contacts_create failed: ${reason}`);
          return `Unable to save contact: ${reason}`;
        }
      },
      {
        name: 'contacts_create',
        description:
          'Create a personal contact for the current chat. Provide name and optional birthday in any common format. The tool normalizes to ISO (YYYY-MM-DD).',
        schema: z.object({
          name: z.string().min(1, 'Name is required'),
          birthday: z.string().optional().describe('Any common date format; will be normalized to ISO if valid'),
          contactId: z.string().optional(),
        }),
      },
    ),

    // EXISTING: contacts_set_birthday (enhanced with date normalization)
    tool(
      async ({ contactId, birthday }: SetBirthdayArgs, config) => {
        try {
          const threadKey = this.extractChatId(config);
          const recentHandle = await this.memoryService.getHandle(threadKey, 'last_contact_id');
          const recentContactId = typeof recentHandle === 'string' ? recentHandle : undefined;
          const targetId = contactId?.trim() || recentContactId;

          if (!targetId) {
            return 'No contact id provided and no recent contact is known. Use contacts_find_by_name first.';
          }

          const iso = this.datesService.normalizeToISO(birthday);
          if (!iso) {
            return 'Please provide a valid date (e.g., 1991-05-14 or 14.05.1991).';
          }

          const updated = await this.contactsService.setBirthday(threadKey, targetId, iso);
          return `Updated birthday for ${updated.name} (id: ${updated.id}) to ${updated.birthday}.`;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          this.logger.warn(`contacts_set_birthday failed: ${reason}`);
          return `Unable to update birthday: ${reason}`;
        }
      },
      {
        name: 'contacts_set_birthday',
        description:
          'Update a contact’s birthday. Accepts common date formats and normalizes to ISO (YYYY-MM-DD). Prefer specifying contactId or use the most recent contact.',
        schema: z.object({
          contactId: z.string().optional(),
          birthday: z.string().min(4, 'birthday is required'),
        }),
      },
    ),

    // existing reminders_get_upcoming unchanged
  ];
}

4) services/agent-server/src/policies/prompt.policy.ts (UPDATE)
- Nudge the LLM to use the new tool and trust tool-side date normalization.

Code
export const DEFAULT_SYSTEM_PROMPT = `You are a focused personal AI assistant.

Core principles:
- Use the provided tools to manipulate contacts and reminders; do not invent data.
- When the user mentions a person by name but no id, call contacts_find_by_name first to retrieve candidate ids.
- When the user provides a birthday in any format, call contacts_set_birthday with the raw string; the tool will normalize to ISO.
- When creating contacts and a birthday is provided in any format, pass it as-is; the tool will normalize.
- When the user asks for events/reminders/birthdays, call reminders_get_upcoming and return its output verbatim unless the user asks for more context.
- If a tool call fails, briefly explain and offer a retry.
- Be concise and direct; ask for clarification only when necessary.`;

Acceptance criteria
- “Create contact Alice. Set her birthday to 14.05.1991.” succeeds without requiring ISO input.
- “Set Bob’s birthday to 1991/5/2” stores 1991-05-02.
- “Set Charlie’s birthday to 05/14/1991” stores 1991-05-14 (US format supported).
- When a name is provided without id, the model uses contacts_find_by_name before updates.

Rollback
- Revert DatesService, prompt changes, and the new tool; existing tools continue to work (with reduced robustness).

------------------------------------------------------------
Stage 6 PRD — Checkpointer adoption (stop manual history replay when enabled)

Objective
- Persist graph state per thread with a checkpointer so each run resumes from prior state.
- Remove manual history reconstruction and MemoryService window writes in checkpointer mode.
- Keep a feature flag (features.enableCheckpointer) to toggle between legacy replay mode and checkpointer mode.

In scope
- Add a checkpointer to GraphFactory.
- Pass thread_id via RunnableConfig.configurable.
- Orchestrator: when checkpointer is enabled, do not write user messages to MemoryService window and do not rebuild history. Instead, invoke the graph with only the current HumanMessage.
- Keep tool handles via MemoryService as-is (unchanged).
- Keep legacy path available behind the feature flag.

Out of scope
- Streaming and interrupts (later stages).
- Migrating existing MemoryService window history to a durable store.

Behavioral changes (when features.enableCheckpointer=true)
- Reduced latency and memory footprint for long threads.
- Equivalent user-visible behavior.

Files to add/change (server)

1) services/agent-server/src/orchestrator/langgraph/graph.factory.ts (ADD checkpointer)
- Use MemorySaver from @langchain/langgraph.
- Only attach checkpointer when enabled (read from AppConfigService.features).

Code
import { Injectable } from '@nestjs/common';
import { MessagesAnnotation, START, END, StateGraph } from '@langchain/langgraph';
import { MemorySaver } from '@langchain/langgraph'; // if your version requires a path import, use '@langchain/langgraph/checkpoint/memory'
import { AppConfigService } from '../../config/config.service';
import { PlannerNode } from './nodes/planner.node';
import { ToolRouterNode } from './nodes/tool-router.node';

export type CompiledGraph = ReturnType<StateGraph<typeof MessagesAnnotation>['compile']>;

@Injectable()
export class GraphFactory {
private compiledGraph: CompiledGraph | null = null;

constructor(
private readonly plannerNode: PlannerNode,
private readonly toolRouterNode: ToolRouterNode,
private readonly config: AppConfigService,
) {}

build(): CompiledGraph {
if (!this.compiledGraph) {
const workflow = new StateGraph(MessagesAnnotation)
.addNode('planner', (state, cfg) => this.plannerNode.execute(state, cfg))
.addNode('tool-router', (state, cfg) => this.toolRouterNode.execute(state, cfg))
.addEdge(START, 'planner')
.addConditionalEdges('planner', (s) => this.plannerNode.determineNext(s), {
tool: 'tool-router',
respond: END,
})
.addEdge('tool-router', 'planner');

      if (this.config.features.enableCheckpointer) {
        const saver = new MemorySaver();
        this.compiledGraph = workflow.compile({ checkpointer: saver }) as unknown as CompiledGraph;
      } else {
        this.compiledGraph = workflow.compile() as unknown as CompiledGraph;
      }
    }
    return this.compiledGraph;
}
}

2) services/agent-server/src/orchestrator/orchestrator.service.ts (BRANCH on flag)
- If enableCheckpointer is true:
    - Do not push the user message to MemoryService window.
    - Do not call HistoryBuilder.
    - Invoke graph with the single new user message and thread_id.
    - Optionally skip GeneratedMessagePersister to avoid duplicating state (recommended).
- If false, keep the current legacy path.

Code (excerpt showing the branching)
import { HumanMessage, BaseMessage, isBaseMessage } from '@langchain/core/messages';
import { AppConfigService } from '../config/config.service';

constructor(
private readonly memoryService: MemoryService,
private readonly graphFactory: GraphFactory,
private readonly historyBuilder: HistoryBuilderService,
private readonly generatedMessagePersister: GeneratedMessagePersisterService,
private readonly commandRouter: CommandRouter,
private readonly inputNormalizer: InputNormalizer,
private readonly responseBuilder: ResponseBuilder,
private readonly config: AppConfigService,
@Inject(MESSAGE_SERIALIZER) private readonly messageTransformer: MessageSerializer,
) { this.graph = this.graphFactory.build(); }

async handleEvent(evt: NormalizedEventDto): Promise<AgentResponseDto> {
if (evt.type === 'command' && evt.text) {
return this.commandRouter.handle(evt);
}

const threadKey = buildThreadKey(evt.connectorId, evt.chatId);
const userText = this.inputNormalizer.toText(evt);

if (this.config.features.enableCheckpointer) {
// Checkpointer mode: only send the new message; graph resumes prior state via thread_id
const result = await this.graph.invoke(
{ messages: [new HumanMessage(userText)] },
{ configurable: { thread_id: threadKey, chatId: threadKey } },
);

    const messages = (Array.isArray(result.messages) ? result.messages : []).filter(isBaseMessage);
    // Optionally skip persistence when using a checkpointer to avoid redundancy
    // await this.generatedMessagePersister.persistGeneratedMessages(threadKey, messages); // usually unnecessary now

    return this.responseBuilder.build(evt.chatId, messages, 0);
}

// Legacy replay mode (unchanged)
await this.memoryService.pushMessage(threadKey, { role: 'user', content: userText, meta: this.inputNormalizer.userMeta(evt) });
const window = await this.memoryService.getWindow(threadKey);
const history = this.historyBuilder.buildHistory(window);
const initialLength = history.length;

const result = await this.graph.invoke({ messages: history }, { configurable: { chatId: threadKey }});
const messages = (Array.isArray(result.messages) ? result.messages : []).filter(isBaseMessage);

await this.generatedMessagePersister.persistGeneratedMessages(threadKey, messages.slice(initialLength));
return this.responseBuilder.build(evt.chatId, messages, initialLength);
}

3) services/agent-server/src/orchestrator/langgraph/nodes/tool-router.node.ts
- No change required. It reads configurable.chatId; we now pass threadKey there. If you want to clarify naming, rename extractChatId → extractThreadKey later.

Acceptance criteria
- With ENABLE_CHECKPOINTER=true, repeated messages in long threads no longer require rebuilding history; performance is stable as conversation grows.
- With the flag off, behavior remains exactly as before.
- Tool behavior remains unchanged (handles still keyed by threadKey).

Rollback
- Disable the flag; the legacy replay path remains in code.

Notes
- If your installed @langchain/langgraph version requires a different import path for MemorySaver, adjust import accordingly.
- In later stages, replace MemorySaver with a Redis/Postgres checkpointer to persist across restarts.

------------------------------------------------------------
Stage 7 PRD — Monica client hardening and reminders caching

Objective
- Make Monica API calls resilient: add timeouts and retries for transient failures.
- Avoid hammering Monica by caching reminders for a short TTL in Redis.
- Add a maximum pages guard when paginating reminders.

In scope
- MonicaClient request timeouts and retry with exponential backoff + jitter on 5xx/429 and network errors.
- Configurable timeouts/retries/backoff parameters.
- Cache layer for reminders with configurable TTL (global cache across threads).
- Max pages guard in fetchAllReminders.

Out of scope
- Advanced circuit breakers or bulkhead isolation (future work if needed).

Config changes (server)
- Add the following envs with defaults:
    - MONICA_TIMEOUT_MS (default 10000)
    - MONICA_MAX_RETRIES (default 3)
    - MONICA_RETRY_BASE_MS (default 300)
    - MONICA_MAX_PAGES (default 100) — safety guard
    - REMINDERS_CACHE_TTL_SEC (default 120)

Files to add/change (server)

1) services/agent-server/src/config/config.validation.ts (ADD)
- Extend zod schema with new envs.

Code (add to envSchema)
MONICA_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
MONICA_MAX_RETRIES: z.coerce.number().int().min(0).default(3),
MONICA_RETRY_BASE_MS: z.coerce.number().int().min(50).default(300),
MONICA_MAX_PAGES: z.coerce.number().int().min(1).default(100),
REMINDERS_CACHE_TTL_SEC: z.coerce.number().int().min(10).default(120),

2) services/agent-server/src/config/config.types.ts (ADD)
- Extend MonicaSection and add a RemindersSection.

Code
export interface MonicaSection {
url: string;
token: string;
websiteUrl: string;
timeoutMs: number;       // NEW
maxRetries: number;      // NEW
retryBaseMs: number;     // NEW
maxPages: number;        // NEW
}

export interface RemindersSection {
cacheTtlSeconds: number;
}

export interface AppConfig {
app: AppSection;
redis: RedisSection;
memory: MemorySection;
ai: AiSection;
monica: MonicaSection;
features: FeaturesSection;
reminders: RemindersSection; // NEW
}

3) services/agent-server/src/config/configuration.ts (MAP)
- Map env to config sections.

Code (monica + reminders excerpts)
monica: {
url: process.env.MONICA_API_URL ?? 'https://app.monicahq.com/api',
token: process.env.MONICA_API_TOKEN ?? '',
websiteUrl: process.env.MONICA_WEB_URL ?? 'https://app.monicahq.com',
timeoutMs: Number(process.env.MONICA_TIMEOUT_MS ?? 10_000),
maxRetries: Number(process.env.MONICA_MAX_RETRIES ?? 3),
retryBaseMs: Number(process.env.MONICA_RETRY_BASE_MS ?? 300),
maxPages: Number(process.env.MONICA_MAX_PAGES ?? 100),
},
reminders: {
cacheTtlSeconds: Number(process.env.REMINDERS_CACHE_TTL_SEC ?? 120),
},

4) services/agent-server/src/config/config.service.ts (ACCESSORS)
- Add getters for new sections.

Code
get reminders(): RemindersSection {
return this.readSection('reminders', (v): v is RemindersSection => !!v && typeof (v as any).cacheTtlSeconds === 'number');
}

5) services/agent-server/src/common/cache.service.ts (NEW)
- Simple Redis JSON cache for cross-thread data.

Code
import { Inject, Injectable } from '@nestjs/common';
import { REDIS_CLIENT, RedisClient } from '../memory/redis.provider';

@Injectable()
export class CacheService {
constructor(@Inject(REDIS_CLIENT) private readonly redis: RedisClient) {}

private k(key: string): string { return `cache:${key}`; }

async get<T>(key: string): Promise<T | undefined> {
const raw = await this.redis.get(this.k(key));
if (!raw) return undefined;
try { return JSON.parse(raw) as T; } catch { return undefined; }
}

async set<T>(key: string, value: T, ttlSec: number): Promise<void> {
await this.redis.set(this.k(key), JSON.stringify(value), { EX: ttlSec });
}
}

6) services/agent-server/src/common/common.module.ts (REGISTER)
- Provide CacheService.

Code
import { CacheService } from './cache.service';

@Module({
providers: [
{ provide: APP_FILTER, useClass: GlobalExceptionFilter },
{ provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
CacheService,
],
exports: [CacheService],
})
export class CommonModule {}

7) services/agent-server/src/integrations/monica/monica.client.ts (HARDEN REQUESTS)
- Add timeout via AbortSignal.timeout.
- Add retry with exponential backoff + jitter for retryable statuses and network errors.

Code (replace request<TResponse, TBody> with retry-capable version)
private async request<TResponse, TBody>(
method: string,
path: string,
options?: MonicaRequestOptions<TBody, TResponse>,
): Promise<TResponse | null> {
const effective = options ?? {};
const url = this.buildUrl(path, effective.query);
const headers = this.buildHeaders(effective.headers);

const timeoutMs = this.config.monica.timeoutMs;
const maxRetries = this.config.monica.maxRetries;
const baseDelay = this.config.monica.retryBaseMs;

let attempt = 0;
// Simple retry loop
// Retry on fetch/network errors, 5xx, and 429
while (true) {
attempt += 1;
const signal = AbortSignal.timeout(timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: effective.body !== undefined ? JSON.stringify(effective.body) : undefined,
        signal,
      });

      if (!response.ok) {
        if (this.isRetryable(response.status) && attempt <= maxRetries) {
          await this.sleepWithJitter(baseDelay, attempt);
          continue;
        }
        throw await this.toError(response);
      }

      if (response.status === 204) {
        return null;
      }

      const payload: unknown = await response.json();
      if (!effective.parseResponse) {
        throw new Error(`Missing response parser for Monica ${method} ${path} request.`);
      }
      return effective.parseResponse(payload);
    } catch (e) {
      const isAbort = e instanceof Error && e.name === 'TimeoutError';
      const isNetwork = e instanceof Error && (e.message?.includes('fetch') || e.message?.includes('network'));
      if ((isAbort || isNetwork) && attempt <= maxRetries) {
        await this.sleepWithJitter(baseDelay, attempt);
        continue;
      }
      // Re-throw other errors
      throw e;
    }
}
}

private isRetryable(status: number): boolean {
return status === 429 || (status >= 500 && status < 600);
}

private async sleepWithJitter(baseMs: number, attempt: number): Promise<void> {
const backoff = baseMs * Math.pow(2, attempt - 1);
const jitter = Math.floor(Math.random() * Math.min(250, backoff * 0.1));
await new Promise((r) => setTimeout(r, backoff + jitter));
}

8) services/agent-server/src/integrations/monica/reminders/monica-reminders.service.ts (ADD maxPages guard)
- Ensure fetchAllReminders respects max pages from config and logs when exceeded.

Code (excerpt)
constructor(
private readonly monicaClient: MonicaClient,
private readonly appConfig: AppConfigService,
) {}

async fetchAllReminders(): Promise<MonicaReminder[]> {
const reminders: MonicaReminder[] = [];
let page = 1;
const maxPages = Math.max(1, this.appConfig.monica.maxPages);

while (true) {
if (page > maxPages) {
this.logger.warn(`Aborting reminders pagination after ${maxPages} pages (safety guard).`);
break;
}

    const response = await this.monicaClient.get<MonicaReminderListResponse>('/reminders', {
      query: { limit: this.pageSize, page },
      parseResponse: parseMonicaReminderListResponse,
    });

    if (!response) break;

    reminders.push(...response.data);
    if (!response.links?.next) break;
    page += 1;
}

this.logger.debug(`Fetched ${reminders.length} Monica reminders across ${page - 1} page(s)`);
return reminders;
}

9) services/agent-server/src/api/reminders/reminders.service.ts (CACHE)
- Use CacheService with TTL from config.reminders.cacheTtlSeconds.
- Cache a normalized array the tool can render quickly.

Code (excerpt)
import { CacheService } from '../../common/cache.service';

@Injectable()
export class RemindersService {
private readonly CACHE_KEY = 'monica:reminders:all';

constructor(
private readonly remindersService: MonicaRemindersService,
private readonly configService: AppConfigService,
private readonly cache: CacheService,
) {}

async getReminders(): Promise<ReminderItem[]> {
const ttl = this.configService.reminders.cacheTtlSeconds;

    const cached = await this.cache.get<ReminderItem[]>(this.CACHE_KEY);
    if (cached && Array.isArray(cached)) {
      return cached;
    }

    const reminders = await this.remindersService.fetchAllReminders();
    const items = this.transformToItems(reminders);

    // Cache best-effort; do not throw on errors
    await this.cache.set(this.CACHE_KEY, items, ttl).catch(() => undefined);

    return items;
}

private transformToItems(reminders: MonicaReminder[]): ReminderItem[] {
// existing mapping you already have in getReminders() — extracted to a helper
// paste your current logic from getReminders and reuse here
// ...
return []; // replace with actual
}

// getRemindersTodayMessage() stays the same, now benefits from caching
}

10) Optional user-facing improvements
- In the reminders_get_upcoming tool (tool-router), leave as-is; it will benefit from caching through RemindersService.

Acceptance criteria
- Transient Monica failures (timeouts, 500, 429) are retried with backoff; on persistent failures, the error is logged and propagated as before.
- Reminders fetched repeatedly within the TTL come from cache and are fast.
- Pagination cannot run indefinitely due to the maxPages safety guard.

Rollback
- Revert request retry logic in MonicaClient and remove cache usage in RemindersService; behavior returns to pre-hardening state.

------------------------------------------------------------
Quick implementation checklist (copy/paste)

Stage 5
- Add DatesService; export in ToolsModule.
- Update tool-router.node.ts to:
    - Use DatesService in contacts_create and contacts_set_birthday.
    - Add contacts_find_by_name tool.
- Update prompt.policy.ts with guidance for find_by_name and date normalization.

Stage 6
- GraphFactory: compile with MemorySaver when features.enableCheckpointer is true.
- OrchestratorService: if checkpointer enabled, send [HumanMessage(userText)] with configurable { thread_id, chatId } and skip MemoryService window write and HistoryBuilder. Else, keep legacy flow.

Stage 7
- Config: add MONICA_* and REMINDERS_CACHE_TTL_SEC; map to config service.
- Add CacheService and register it in CommonModule.
- MonicaClient: add timeout + retry with exponential backoff + jitter; classify retryable statuses.
- MonicaRemindersService: guard on max pages.
- RemindersService: use CacheService to cache getReminders() result for TTL.

These stages are independent of CI/e2e and can be merged in order with low risk.