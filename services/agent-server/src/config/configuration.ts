import { AppConfig } from './config.types';
import { DEFAULT_LLM_MODEL, DEFAULT_REDIS_HOST } from './config.defaults';

const parseNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseBoolean = (value: string | undefined): boolean =>
  (value ?? '').trim().toLowerCase() === 'true';

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
  ai: {
    apiKey: process.env.OPENAI_API_KEY ?? '',
    model: process.env.LLM_MODEL ?? DEFAULT_LLM_MODEL,
  },
  monica: {
    url: process.env.MONICA_API_URL ?? 'https://app.monicahq.com/api',
    token: process.env.MONICA_API_TOKEN ?? '',
    websiteUrl: process.env.MONICA_WEB_URL ?? 'https://app.monicahq.com',
  },
  features: {
    enableCheckpointer: parseBoolean(process.env.ENABLE_CHECKPOINTER),
    enableStreaming: parseBoolean(process.env.ENABLE_STREAMING),
    enableIdempotency: parseBoolean(process.env.ENABLE_IDEMPOTENCY),
  },
});
