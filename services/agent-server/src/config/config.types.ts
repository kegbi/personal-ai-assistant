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
  features: FeaturesSection;
}
