import { AppConfig, LogFormat, OTelExporter } from './config.types';
import { DEFAULT_LLM_MODEL, DEFAULT_REDIS_HOST } from './config.defaults';

const parseNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseBoolean = (value: string | undefined): boolean =>
  (value ?? '').trim().toLowerCase() === 'true';

const parseLogFormat = (value: string | undefined): LogFormat =>
  (value ?? '').trim().toLowerCase() === 'json' ? 'json' : 'pretty';

const parseExporter = (value: string | undefined): OTelExporter =>
  (value ?? '').trim().toLowerCase() === 'otlp' ? 'otlp' : 'console';

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
    timeoutMs: parseNumber(process.env.MONICA_TIMEOUT_MS, 10_000),
    maxRetries: parseNumber(process.env.MONICA_MAX_RETRIES, 3),
    retryBaseMs: parseNumber(process.env.MONICA_RETRY_BASE_MS, 300),
    maxPages: parseNumber(process.env.MONICA_MAX_PAGES, 100),
  },
  reminders: {
    cacheTtlSeconds: parseNumber(process.env.REMINDERS_CACHE_TTL_SEC, 300),
  },
  features: {
    enableCheckpointer: parseBoolean(process.env.ENABLE_CHECKPOINTER),
    enableStreaming: parseBoolean(process.env.ENABLE_STREAMING),
    enableIdempotency: parseBoolean(process.env.ENABLE_IDEMPOTENCY),
  },
  logging: {
    format: parseLogFormat(process.env.LOG_FORMAT),
  },
  tracing: {
    enabled: parseBoolean(process.env.ENABLE_OTEL_TRACING),
    exporter: parseExporter(process.env.OTEL_EXPORTER),
    otlpEndpoint:
      process.env.OTEL_OTLP_ENDPOINT &&
      process.env.OTEL_OTLP_ENDPOINT.trim().length > 0
        ? process.env.OTEL_OTLP_ENDPOINT
        : undefined,
  },
});
