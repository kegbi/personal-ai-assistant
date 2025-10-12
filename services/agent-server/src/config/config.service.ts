import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AiSection,
  AppConfig,
  AppSection,
  MemorySection,
  MonicaSection,
  RedisSection,
  SecuritySection,
} from './config.types';

@Injectable()
export class AppConfigService {
  constructor(
    private readonly configService: ConfigService<AppConfig, true>,
  ) {}

  get app(): AppSection {
    return this.configService.get<AppSection>('app', { infer: true });
  }

  get redis(): RedisSection {
    return this.configService.get<RedisSection>('redis', { infer: true });
  }

  get memory(): MemorySection {
    return this.configService.get<MemorySection>('memory', { infer: true });
  }

  get security(): SecuritySection {
    return this.configService.get<SecuritySection>('security', { infer: true });
  }

  get ai(): AiSection {
    return this.configService.get<AiSection>('ai', { infer: true });
  }

  get monica(): MonicaSection {
    return this.configService.get<MonicaSection>('monica', { infer: true });
  }
}
