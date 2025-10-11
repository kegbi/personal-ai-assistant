import { AppConfig } from './config.types';

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
    host: process.env.REDIS_HOST ?? 'localhost',
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
    model: process.env.LLM_MODEL ?? 'gpt-4o-mini',
  },
});
