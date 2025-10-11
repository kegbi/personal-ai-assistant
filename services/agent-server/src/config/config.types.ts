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

export interface SecuritySection {
  allowedChatId?: string | null;
}

export interface AiSection {
  apiKey: string;
  model: string;
}

export interface AppConfig {
  app: AppSection;
  redis: RedisSection;
  memory: MemorySection;
  security: SecuritySection;
  ai: AiSection;
}
