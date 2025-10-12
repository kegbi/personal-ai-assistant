import { AppConfig } from './config.types';
import { DEFAULT_LLM_MODEL, DEFAULT_REDIS_HOST } from './config.defaults';

const parseNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const trimOrNull = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
};

export default (): AppConfig => ({
  app: {
    port: parseNumber(process.env.PORT, 3000),
  },
  redis: {
    host: process.env.REDIS_HOST ?? DEFAULT_REDIS_HOST,
    port: parseNumber(process.env.REDIS_PORT, 6379),
  },
  memory: {
    windowSize: parseNumber(process.env.MEM_WINDOW_SIZE, 15),
    handleTtlSeconds: parseNumber(process.env.HANDLE_TTL_SECONDS, 7200),
  },
  security: {
    allowedChatId: trimOrNull(process.env.ALLOWED_CHAT_ID),
  },
  ai: {
    apiKey: process.env.OPENAI_API_KEY ?? '',
    model: process.env.LLM_MODEL ?? DEFAULT_LLM_MODEL,
  },
  monica: {
    url: process.env.MONICA_API_URL ?? 'https://app.monicahq.com/api',
    token: process.env.MONICA_API_TOKEN ?? '',
    websiteUrl: process.env.MONICA_WEB_URL ?? 'https://app.monicahq.com',
  },
});
