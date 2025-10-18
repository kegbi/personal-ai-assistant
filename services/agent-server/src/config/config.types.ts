export interface AppSection {
  port: number;
}

export interface RedisTlsSection {
  enabled: boolean;
  rejectUnauthorized: boolean;
}

export interface RedisSection {
  host: string;
  port: number;
  password?: string;
  tls: RedisTlsSection;
}

export interface MemorySection {
  windowSize: number;
  handleTtlSeconds: number;
}

export interface AiSection {
  apiKey: string;
  model: string;
}

export interface MonicaSection {
  url: string;
  token: string;
  websiteUrl: string;
  timeoutMs: number;
  maxRetries: number;
  retryBaseMs: number;
  maxPages: number;
}

export interface RemindersSection {
  cacheTtlSeconds: number;
}

export interface FeaturesSection {
  enableCheckpointer: boolean;
  enableStreaming: boolean;
  enableIdempotency: boolean;
}

export type LogFormat = 'json' | 'pretty';

export interface LoggingSection {
  format: LogFormat;
}

export type OTelExporter = 'console' | 'otlp';

export interface RateLimitSection {
  perMinute: number;
  burst: number;
}

export interface TracingSection {
  enabled: boolean;
  exporter: OTelExporter;
  otlpEndpoint?: string;
}

export interface AppConfig {
  app: AppSection;
  redis: RedisSection;
  memory: MemorySection;
  ai: AiSection;
  monica: MonicaSection;
  reminders: RemindersSection;
  features: FeaturesSection;
  logging: LoggingSection;
  rateLimit: RateLimitSection;
  tracing: TracingSection;
}
