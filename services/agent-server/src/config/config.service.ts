import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AiSection,
  AppConfig,
  AppSection,
  FeaturesSection,
  MemorySection,
  MonicaSection,
  RemindersSection,
  RedisSection,
} from './config.types';

type ConfigSectionGuard<TKey extends keyof AppConfig> = (
  value: unknown,
) => value is AppConfig[TKey];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === 'string';

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isBoolean = (value: unknown): value is boolean =>
  typeof value === 'boolean';

const isAppSection: ConfigSectionGuard<'app'> = (
  value: unknown,
): value is AppConfig['app'] => isRecord(value) && isNumber(value.port);

const isRedisSection: ConfigSectionGuard<'redis'> = (
  value: unknown,
): value is AppConfig['redis'] =>
  isRecord(value) && isString(value.host) && isNumber(value.port);

const isMemorySection: ConfigSectionGuard<'memory'> = (
  value: unknown,
): value is AppConfig['memory'] =>
  isRecord(value) &&
  isNumber(value.windowSize) &&
  isNumber(value.handleTtlSeconds);

const isAiSection: ConfigSectionGuard<'ai'> = (
  value: unknown,
): value is AppConfig['ai'] =>
  isRecord(value) && isString(value.apiKey) && isString(value.model);

const isMonicaSection: ConfigSectionGuard<'monica'> = (
  value: unknown,
): value is AppConfig['monica'] =>
  isRecord(value) &&
  isString(value.url) &&
  isString(value.token) &&
  isString(value.websiteUrl) &&
  isNumber(value.timeoutMs) &&
  isNumber(value.maxRetries) &&
  isNumber(value.retryBaseMs) &&
  isNumber(value.maxPages);

const isRemindersSection: ConfigSectionGuard<'reminders'> = (
  value: unknown,
): value is RemindersSection =>
  isRecord(value) && isNumber(value.cacheTtlSeconds);

const isFeaturesSection: ConfigSectionGuard<'features'> = (
  value: unknown,
): value is FeaturesSection =>
  isRecord(value) &&
  isBoolean(value.enableCheckpointer) &&
  isBoolean(value.enableStreaming) &&
  isBoolean(value.enableIdempotency);

@Injectable()
export class AppConfigService {
  constructor(private readonly configService: ConfigService<AppConfig, true>) {}

  get app(): AppSection {
    return this.readSection('app', isAppSection);
  }

  get redis(): RedisSection {
    return this.readSection('redis', isRedisSection);
  }

  get memory(): MemorySection {
    return this.readSection('memory', isMemorySection);
  }

  get ai(): AiSection {
    return this.readSection('ai', isAiSection);
  }

  get monica(): MonicaSection {
    return this.readSection('monica', isMonicaSection);
  }

  get reminders(): RemindersSection {
    return this.readSection('reminders', isRemindersSection);
  }

  get features(): FeaturesSection {
    return this.readSection('features', isFeaturesSection);
  }

  /**
   * Retrieves and validates a configuration section ensuring expected shape.
   *
   * @param key Configuration key to resolve.
   * @param guard Type guard that confirms the resolved value matches the expected schema.
   * @throws Error when the configuration section is missing or malformed.
   * @returns Strongly typed configuration section.
   */
  private readSection<TKey extends keyof AppConfig>(
    key: TKey,
    guard: ConfigSectionGuard<TKey>,
  ): AppConfig[TKey] {
    const rawSection: unknown = this.configService.get<AppConfig[TKey]>(key, {
      infer: true,
    });

    if (!guard(rawSection)) {
      throw new Error(`Invalid ${String(key)} configuration section.`);
    }

    return rawSection;
  }
}
