export interface AppSection {
  port: number;
}

export interface RedisSection {
  host: string;
  port: number;
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

export interface AppConfig {
  app: AppSection;
  redis: RedisSection;
  memory: MemorySection;
  ai: AiSection;
  monica: MonicaSection;
  reminders: RemindersSection;
  features: FeaturesSection;
}
