import { z } from 'zod';

export interface AdapterConfig {
  tgBotToken: string;
  agentBaseUrl: string;
  agentAuthToken?: string;
  allowedChatIds: string[];
  longPollingTimeoutMs: number;
  agentTimeoutMs: number;
  healthPort: number;
  dropPendingUpdates: boolean;
}

const coerceBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
};

const configSchema = z.object({
  tgBotToken: z.string().min(1, 'TG_BOT_TOKEN is required'),
  agentBaseUrl: z
    .string()
    .min(1, 'AGENT_BASE_URL is required')
    .transform((value) => value.replace(/\/+$/, '')),
  agentAuthToken: z.string().min(1).optional(),
  allowedChatIds: z.array(z.string().min(1)).default([]),
  longPollingTimeoutMs: z.number().int().positive().default(30_000),
  agentTimeoutMs: z.number().int().positive().default(45_000),
  healthPort: z.number().int().positive().default(8081),
  dropPendingUpdates: z.boolean().default(true),
  mode: z.literal('polling'),
});

const gatherAllowedChatIds = (): string[] => {
  const envValue = process.env.ALLOWED_CHAT_IDS;
  if (!envValue || envValue.trim().length === 0) {
    return [];
  }

  return Array.from(
    new Set(
      envValue
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  );
};

export const loadConfig = (): AdapterConfig => {
  const parsed = configSchema.parse({
    tgBotToken: process.env.TG_BOT_TOKEN,
    agentBaseUrl: process.env.AGENT_BASE_URL,
    agentAuthToken: process.env.AGENT_AUTH_TOKEN ?? process.env.AGENT_API_KEY,
    allowedChatIds: gatherAllowedChatIds(),
    longPollingTimeoutMs: process.env.TG_POLLING_TIMEOUT_MS
      ? Number(process.env.TG_POLLING_TIMEOUT_MS)
      : undefined,
    agentTimeoutMs: process.env.AGENT_TIMEOUT_MS
      ? Number(process.env.AGENT_TIMEOUT_MS)
      : undefined,
    healthPort: process.env.HEALTH_PORT ? Number(process.env.HEALTH_PORT) : undefined,
    dropPendingUpdates: coerceBoolean(process.env.TG_DROP_PENDING_UPDATES, true),
    mode: (process.env.TG_MODE ?? 'polling').toLowerCase(),
  });

  return {
    tgBotToken: parsed.tgBotToken,
    agentBaseUrl: parsed.agentBaseUrl,
    agentAuthToken: parsed.agentAuthToken,
    allowedChatIds: parsed.allowedChatIds,
    longPollingTimeoutMs: parsed.longPollingTimeoutMs,
    agentTimeoutMs: parsed.agentTimeoutMs,
    healthPort: parsed.healthPort,
    dropPendingUpdates: parsed.dropPendingUpdates,
  };
};
