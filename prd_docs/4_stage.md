Stage 11 PRD — Multi‑connector readiness (versioned contract + principal identity + second adapter skeleton)

Objective

Make swapping/adding transports trivial.
Ship a versioned, transport‑agnostic contract package shared by adapters and server.
Introduce a simple principal identity map decoupled from connector chat/user identifiers.
Provide a minimal second adapter skeleton to validate the contract (e.g., Web adapter or CLI stub).
In scope

contracts package (shared types/schemas, v1).
Server: accept contractVersion, validate connectorId against allow‑list, and expose a principal mapping service (Redis‑backed).
Optional thread strategy: byThread (default, current) or byPrincipal (single memory across connectors).
Example adapter skeleton (web-adapter) that posts events using the shared contract.
Out of scope

End‑to‑end identity federation, OAuth, or user SSO.
Matrix protocol specifics (can be added later using the same skeleton).
Config additions (server)

ALLOWED_CONNECTORS: comma-separated list (default: telegram,web)
THREAD_STRATEGY: 'byThread' | 'byPrincipal' (default: byThread)
PRINCIPAL_TTL_SECONDS: number (default: 0 meaning no TTL)
CONTRACT_ACCEPTED_VERSIONS: comma-separated (default: v1)
Shared contracts package (monorepo)

Location: packages/contracts
Build: simple tsconfig, export types and zod schemas.
Files to add/change

A) packages/contracts/src/index.ts (NEW)

Single source of truth for event/response shapes and enums.
import { z } from 'zod';

export const ConnectorId = z.enum(['telegram', 'matrix', 'web', 'cli']);
export type ConnectorId = z.infer<typeof ConnectorId>;

export const ContractVersion = z.enum(['v1']);
export type ContractVersion = z.infer<typeof ContractVersion>;

export const NormalizedEventV1 = z.object({
contractVersion: ContractVersion.default('v1'),
connectorId: ConnectorId,
chatId: z.string().min(1),
userId: z.string().min(1).optional(),
type: z.enum(['text', 'voice', 'command', 'other']),
text: z.string().optional(),
voiceUrl: z.string().url().optional(),
idempotencyKey: z.string().optional(),
payload: z.record(z.any()).optional(),
});
export type NormalizedEventV1 = z.infer<typeof NormalizedEventV1>;

export const AgentResponseV1 = z.object({
chatId: z.string().min(1),
text: z.string(),
meta: z
.object({
tool: z.string().optional(),
args: z.record(z.any()).optional(),
elapsedMs: z.number().int().optional(),
})
.optional(),
});
export type AgentResponseV1 = z.infer<typeof AgentResponseV1>;

B) services/agent-server/src/api/transport/dto/normalized-event.dto.ts (ALLOW contractVersion)

Keep class-validator DTO for Nest while acknowledging version.
import { IsIn, IsObject, IsOptional, IsString } from 'class-validator';

export class NormalizedEventDto {
@IsString() @IsIn(['v1'])
contractVersion!: 'v1';

@IsString() connectorId!: string;
@IsString() chatId!: string;
@IsOptional() @IsString() userId?: string;
@IsString() @IsIn(['text','voice','command','other'])
type!: 'text'|'voice'|'command'|'other';
@IsOptional() @IsString() text?: string;
@IsOptional() @IsString() voiceUrl?: string;
@IsOptional() @IsString() idempotencyKey?: string;
@IsOptional() @IsObject() payload?: Record<string, unknown>;
}

C) services/agent-server/src/api/transport/events.controller.ts and events-stream.controller.ts (VALIDATE contract version + connector allow‑list)

Throw 400 if contractVersion not accepted; 403 if connectorId not allowed.
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AppConfigService } from '../../config/config.service';

constructor(/* ... */ private readonly cfg: AppConfigService) {}

private ensureContractAndConnector(dto: NormalizedEventDto) {
const accepted = (process.env.CONTRACT_ACCEPTED_VERSIONS ?? 'v1').split(',').map(s=>s.trim());
if (!accepted.includes(dto.contractVersion ?? 'v1')) {
throw new BadRequestException(Unsupported contract version ${dto.contractVersion});
}
const allowed = (process.env.ALLOWED_CONNECTORS ?? 'telegram,web').split(',').map(s=>s.trim());
if (!allowed.includes(dto.connectorId)) {
throw new ForbiddenException(Connector ${dto.connectorId} not permitted);
}
}

@Post()
async post(@Body() dto: NormalizedEventDto): Promise<AgentResponseDto> {
this.ensureContractAndConnector(dto);
// idempotency flow remains
return this.orchestrator.handleEvent(dto);
}

D) services/agent-server/src/common/principal-map.service.ts (NEW)

Deterministic or assigned principal IDs for (connectorId,userId).
Redis Hash: principal:{connectorId}:{userId} -> principalId and reverse set principal_rev:{principalId} => JSON list for introspection.
import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { REDIS_CLIENT, RedisClient } from '../memory/redis.provider';

@Injectable()
export class PrincipalMapService {
constructor(@Inject(REDIS_CLIENT) private readonly redis: RedisClient) {}

private key(connectorId: string, userId: string) {
return principal:${connectorId}:${userId};
}
private revKey(principalId: string) {
return principal_rev:${principalId};
}

private computeDeterministic(connectorId: string, userId: string): string {
const h = createHash('sha256').update(${connectorId}:${userId}).digest('hex').slice(0, 16);
return p_${h};
}

async getOrCreate(connectorId: string, userId: string, ttlSeconds = Number(process.env.PRINCIPAL_TTL_SECONDS ?? 0)): Promise<string> {
const k = this.key(connectorId, userId);
const existing = await this.redis.get(k);
if (existing) return existing;

const principalId = this.computeDeterministic(connectorId, userId);
if (ttlSeconds > 0) {
await this.redis.set(k, principalId, { EX: ttlSeconds });
} else {
await this.redis.set(k, principalId);
}
await this.redis.sAdd(this.revKey(principalId), `${connectorId}:${userId}`).catch(()=>undefined);
return principalId;
}
}

E) services/agent-server/src/orchestrator/orchestrator.service.ts (OPTIONAL thread strategy)

Use THREAD_STRATEGY to choose threadKey.
import { PrincipalMapService } from '../common/principal-map.service';
import { AppConfigService } from '../config/config.service';
import { buildThreadKey } from '../common/keys.util';

constructor(/.../ private readonly principal: PrincipalMapService, private readonly cfg: AppConfigService) { /.../ }

async handleEvent(evt: NormalizedEventDto): Promise<AgentResponseDto> {
if (evt.type === 'command' && evt.text) return this.commandRouter.handle(evt);

const strategy = (process.env.THREAD_STRATEGY ?? 'byThread').toLowerCase();
let threadKey: string;

if (strategy === 'byPrincipal' && evt.userId) {
const principalId = await this.principal.getOrCreate(evt.connectorId, evt.userId);
threadKey = principalId; // unifies memory across connectors for same principal
} else {
threadKey = buildThreadKey(evt.connectorId, evt.chatId);
}

// continue with checkpointer or legacy branch (unchanged),
// but pass { configurable: { thread_id: threadKey, chatId: threadKey } }
}

F) services/agent-server/src/common/common.module.ts (REGISTER PrincipalMapService)
import { PrincipalMapService } from './principal-map.service';
/* ... /
providers: [RequestContext, JsonLogger, / filters/interceptors */, PrincipalMapService],
exports: [PrincipalMapService],

G) Example second adapter skeleton: services/web-adapter (NEW)

Minimal Express server with a single POST /message endpoint and a static HTML chat page (optional).
Uses packages/contracts types and agent-client to call /events or /events/stream.
Directory
services/web-adapter/
src/
index.ts
agent-client.ts (reuse adapter version; or share via workspace)
types.ts (reuse from contracts package)
package.json
tsconfig.json
Dockerfile (optional)

src/index.ts (simplified)
import express from 'express';
import bodyParser from 'body-parser';
import { NormalizedEventV1 } from '../../packages/contracts';
import { AgentClient } from './agent-client';

const app = express();
app.use(bodyParser.json());
const client = new AgentClient(process.env.AGENT_BASE_URL!, { timeoutMs: Number(process.env.AGENT_TIMEOUT_MS ?? 45000), authToken: process.env.AGENT_AUTH_TOKEN });

app.post('/message', async (req, res) => {
const parsed = NormalizedEventV1.parse({
contractVersion: 'v1',
connectorId: 'web',
chatId: req.body.chatId ?? 'anon',
userId: req.body.userId ?? 'anon',
type: 'text',
text: req.body.text,
idempotencyKey: String(Date.now()) + ':' + Math.random().toString(36).slice(2),
payload: { ua: req.headers['user-agent'] },
});

const resp = await client.sendMessage(parsed);
res.json(resp);
});

app.listen(Number(process.env.PORT ?? 8082), () => console.log('web-adapter listening'));

Adapter env

AGENT_BASE_URL, AGENT_AUTH_TOKEN, AGENT_TIMEOUT_MS, PORT
Acceptance criteria

Server rejects requests with unsupported contractVersion or disallowed connectorId.
Optional byPrincipal strategy unifies memory across connectors for the same userId.
A second adapter (web-adapter) posts events conforming to contracts v1 and receives responses successfully.
Rollback

Set THREAD_STRATEGY=byThread; remove web-adapter service from compose; server still accepts telegram.
Stage 12 PRD — Durable memory and optional vector recall

Objective

Add durable, queryable long‑term memory separate from Redis window/checkpointer.
Allow future tools to “remember” and “recall” user facts across sessions and connectors.
Optionally store vector embeddings for semantic recall using pgvector (or keep feature off by default).
Upgrade checkpointer backend from in‑memory to durable (Redis or Postgres) for resilience across restarts.
In scope

PersistenceModule with a Postgres connection and migrations for:
memory_facts (durable facts)
Optional: memory_messages (if you want full transcripts; can be added later)
DurableMemoryService with CRUD and simple search (text + optional vector KNN).
Optional VectorStoreService using OpenAI embeddings and pgvector.
CheckpointerFactory to plug a durable saver into LangGraph compile when enabled.
Out of scope

Complex RAG pipelines, document chunking, multi‑tenant ACLs.
Config additions

DATABASE_URL: postgres connection string (required to enable durable features)
DURABLE_MEMORY_ENABLED: boolean (default false)
VECTOR_ENABLED: boolean (default false)
VECTOR_DIM: number (default 1536 or per your embeddings model)
CHECKPOINTER_BACKEND: 'memory' | 'redis' | 'postgres' (default 'memory')
CHECKPOINTER_REDIS_PREFIX: string (default 'lgcp:')
For embeddings (optional): OPENAI_API_KEY (already present), EMBEDDINGS_MODEL (default 'text-embedding-3-small')
Schema: Postgres
SQL (migrations/001_init.sql)
-- Enable pgvector if VECTOR_ENABLED=true
-- CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS memory_facts (
id BIGSERIAL PRIMARY KEY,
principal_id TEXT NOT NULL,
scope TEXT NOT NULL DEFAULT 'global', -- reserved for future scoping
key TEXT,                             -- optional key for deterministic facts
content TEXT NOT NULL,                -- raw text
meta JSONB DEFAULT '{}'::jsonb,
embedding vector,                     -- only if pgvector enabled; else leave NULL
created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_facts_principal ON memory_facts (principal_id);
CREATE INDEX IF NOT EXISTS idx_memory_facts_updated ON memory_facts (updated_at DESC);
-- If vector enabled:
-- CREATE INDEX IF NOT EXISTS idx_memory_facts_embedding ON memory_facts USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

Optional (if you want transcripts later)
-- CREATE TABLE IF NOT EXISTS memory_messages (...);

Files to add/change

A) services/agent-server/src/persistence/persistence.module.ts (NEW)
import { Module } from '@nestjs/common';
import { DurableMemoryService } from './durable-memory.service';
import { VectorStoreService } from './vector-store.service';
import { AppConfigService } from '../config/config.service';
import { Pool } from 'pg';

@Module({
providers: [
{
provide: 'PG_POOL',
inject: [AppConfigService],
useFactory: async (cfg: AppConfigService) => {
const url = process.env.DATABASE_URL;
if (!url) return null;
const pool = new Pool({ connectionString: url, max: 10 });
return pool;
},
},
DurableMemoryService,
VectorStoreService,
],
exports: [DurableMemoryService, VectorStoreService, 'PG_POOL'],
})
export class PersistenceModule {}

B) services/agent-server/src/persistence/durable-memory.service.ts (NEW)
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { VectorStoreService } from './vector-store.service';

export interface UpsertFactInput {
principalId: string;
content: string;
key?: string;      // optional deterministic key
meta?: Record<string, unknown>;
}

@Injectable()
export class DurableMemoryService {
private readonly logger = new Logger(DurableMemoryService.name);
constructor(@Inject('PG_POOL') private readonly pool: Pool | null, private readonly vectors: VectorStoreService) {}

private ensure(): asserts this is { pool: Pool } {
if (!this.pool) throw new Error('DATABASE_URL not configured');
}

async upsertFact(input: UpsertFactInput): Promise<number> {
this.ensure();
const { principalId, content, key, meta } = input;

const client = await this.pool.connect();
try {
await client.query('BEGIN');
let id: number | null = null;

if (key) {
const res = await client.query<{ id: string }>(
'SELECT id FROM memory_facts WHERE principal_id = $1 AND key = $2 LIMIT 1',
[principalId, key],
);
if (res.rows.length) {
id = Number(res.rows[0].id);
await client.query(
'UPDATE memory_facts SET content=$1, meta=$2, updated_at=now() WHERE id=$3',
[content, JSON.stringify(meta ?? {}), id],
);
}
}

if (!id) {
const ins = await client.query<{ id: string }>(
'INSERT INTO memory_facts (principal_id, key, content, meta) VALUES ($1,$2,$3,$4) RETURNING id',
[principalId, key ?? null, content, JSON.stringify(meta ?? {})],
);
id = Number(ins.rows[0].id);
}

if (process.env.VECTOR_ENABLED?.toLowerCase() === 'true') {
const emb = await this.vectors.embed(content).catch(() => null);
if (emb) {
await client.query('UPDATE memory_facts SET embedding = $1 WHERE id = $2', [emb, id]);
}
}

await client.query('COMMIT');
return id!;
} catch (e) {
await client.query('ROLLBACK');
this.logger.warn(`upsertFact failed: ${e instanceof Error ? e.message : String(e)}`);
throw e;
} finally {
client.release();
}
}

async searchFacts(principalId: string, query: string, limit = 5): Promise<Array<{ id: number; content: string; meta: Record<string, unknown> }>> {
this.ensure();
const vectorOn = process.env.VECTOR_ENABLED?.toLowerCase() === 'true';

if (vectorOn) {
const emb = await this.vectors.embed(query).catch(() => null);
if (!emb) return [];
const rows = await this.pool.query(
'SELECT id, content, meta FROM memory_facts WHERE principal_id=$1 ORDER BY embedding <=> $2 LIMIT $3',
[principalId, emb, limit],
);
return rows.rows.map(r => ({ id: Number(r.id), content: r.content, meta: r.meta ?? {} }));
}

const rows = await this.pool.query(
'SELECT id, content, meta FROM memory_facts WHERE principal_id=$1 AND content ILIKE $2 ORDER BY updated_at DESC LIMIT $3',
[principalId, `%${query}%`, limit],
);
return rows.rows.map(r => ({ id: Number(r.id), content: r.content, meta: r.meta ?? {} }));
}
}

C) services/agent-server/src/persistence/vector-store.service.ts (NEW, optional)
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/config.service';
import { OpenAIEmbeddings } from '@langchain/openai';

@Injectable()
export class VectorStoreService {
private embeddings: OpenAIEmbeddings | null = null;
constructor(private readonly cfg: AppConfigService) {
if ((process.env.VECTOR_ENABLED ?? 'false').toLowerCase() === 'true') {
this.embeddings = new OpenAIEmbeddings({
apiKey: this.cfg.ai.apiKey,
model: process.env.EMBEDDINGS_MODEL || 'text-embedding-3-small',
});
}
}
async embed(text: string): Promise<number[] | null> {
if (!this.embeddings) return null;
const vec = await this.embeddings.embedQuery(text);
return vec;
}
}

D) services/agent-server/src/app.module.ts (IMPORT PersistenceModule)
import { PersistenceModule } from './persistence/persistence.module';
@Module({
imports: [
// ...
PersistenceModule,
],
})
export class AppModule {}

E) Optional tools to leverage durable memory (NEW)

memory_remember: store a fact for the principal (byPrincipal strategy recommended), but can also store under current thread principal derived from (connectorId,userId).
memory_recall: retrieve matching facts.
Add to tool-router.node.ts:

tool(
async ({ content, key }, config) => {
try {
const threadKey = this.extractChatId(config); // this is threadKey
// derive principalId: if strategy is byPrincipal and threadKey already is principal, use it; else map connectorId/userId if available in config.configurable
// For simplicity here, assume threadKey is a principalId when THREAD_STRATEGY=byPrincipal
const principalId = threadKey;
const id = await this.durableMemory.upsertFact({ principalId, content, key });
return Remembered (#${id}).;
} catch (e) {
return Unable to remember: ${e instanceof Error ? e.message : String(e)};
}
},
{
name: 'memory_remember',
description: 'Store a durable fact tied to the current user/principal. Use to remember generic facts that are not contacts.',
schema: z.object({
content: z.string().min(1, 'content is required'),
key: z.string().optional().describe('Optional deterministic key to overwrite'),
}),
},
),
tool(
async ({ query, limit }, config) => {
try {
const threadKey = this.extractChatId(config);
const principalId = threadKey;
const rows = await this.durableMemory.searchFacts(principalId, query, limit ?? 5);
if (!rows.length) return '[]';
return JSON.stringify(rows.map(r => ({ id: r.id, content: r.content })));
} catch (e) {
return [];
}
},
{
name: 'memory_recall',
description: 'Search durable facts for the current user/principal. Returns JSON array [{id, content}].',
schema: z.object({ query: z.string().min(1), limit: z.number().int().positive().max(20).optional() }),
},
),

Wire DurableMemoryService into ToolRouterNode constructor and ToolsModule.

F) CheckpointerFactory for durable backend (optional upgrade)

If CHECKPOINTER_BACKEND=redis or postgres, use the corresponding saver from LangGraph if available in your installed version (naming varies by version). Keep MemorySaver as fallback.
Provide a factory service that returns the saver.
services/agent-server/src/orchestrator/langgraph/checkpointer.factory.ts (NEW)
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../config/config.service';
// import the saver that matches your version; placeholder names below:
@Injectable()
export class CheckpointerFactory {
constructor(private readonly cfg: AppConfigService) {}
build(): any | null {
const backend = (process.env.CHECKPOINTER_BACKEND ?? 'memory').toLowerCase();
if (backend === 'memory') return null;
if (backend === 'redis') {
// Example placeholder; adjust import to your installed version:
// const saver = new RedisSaver({ url: redis://:${process.env.REDIS_PASSWORD}@${this.cfg.redis.host}:${this.cfg.redis.port}, prefix: process.env.CHECKPOINTER_REDIS_PREFIX ?? 'lgcp:' });
// return saver;
return null; // TODO: plug actual saver for your version
}
if (backend === 'postgres') {
// Example placeholder Postgres saver; add table creation if required by lib
return null;
}
return null;
}
}

Update graph.factory.ts to request the saver:
constructor(/.../ private readonly cpFactory: CheckpointerFactory, private readonly cfg: AppConfigService) {}
build(): CompiledGraph {
if (!this.compiledGraph) {
const workflow = /* existing nodes/edges */;
const saver = this.cpFactory.build();
if (saver || this.cfg.features.enableCheckpointer) {
const options = saver ? { checkpointer: saver } : { checkpointer: new MemorySaver() };
this.compiledGraph = workflow.compile(options) as unknown as CompiledGraph;
} else {
this.compiledGraph = workflow.compile() as unknown as CompiledGraph;
}
}
return this.compiledGraph;
}

Operational notes

If VECTOR_ENABLED=true, install pgvector extension and create the vector index. For Docker Postgres: use a custom init script to CREATE EXTENSION pgvector; or use a managed instance supporting pgvector.
Embeddings incur cost; keep VECTOR_ENABLED=false in dev.
For THREAD_STRATEGY=byPrincipal, memory_remember/recall work as cross‑connector durable memory. With byThread, they are per chat/thread.
Acceptance criteria

With DURABLE_MEMORY_ENABLED and DATABASE_URL set, you can store and recall facts for a given principal with memory_remember and memory_recall tools.
With VECTOR_ENABLED, semantic recall orders results by vector similarity; otherwise, fallback to ILIKE search.
Checkpointer can be switched to a durable backend when the appropriate saver is wired; otherwise MemorySaver remains functional.
Rollback

Set DURABLE_MEMORY_ENABLED=false and VECTOR_ENABLED=false; tools remain registered but can early‑return with a message or be hidden by prompt policy.
Keep CHECKPOINTER_BACKEND=memory to revert to MemorySaver.
Security and logging

No new public endpoints. DB credentials in env; do not log secrets.
Structured logs already include correlationId/threadKey; include principalId in logs when THREAD_STRATEGY=byPrincipal (optional: add to RequestContext if derived).
Migration guide

Apply migrations/001_init.sql to your Postgres instance.
If enabling pgvector: CREATE EXTENSION pgvector; then uncomment vector index creation.
Developer checklist (copy/paste)

Stage 11

Create packages/contracts with NormalizedEventV1 and AgentResponseV1. Publish locally via workspace.
Server: accept contractVersion, validate connectorId (ALLOWED_CONNECTORS), add PrincipalMapService, add optional THREAD_STRATEGY switch.
Provide web-adapter skeleton using the contracts package and AgentClient.
Stage 12

Add PersistenceModule with PG pool.
Create DurableMemoryService (upsert/search) and VectorStoreService (optional embeddings).
Add migrations for memory_facts (and pgvector setup if enabled).
Wire up optional tools memory_remember and memory_recall.
Create CheckpointerFactory to allow durable saver in GraphFactory; keep MemorySaver fallback.