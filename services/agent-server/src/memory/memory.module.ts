import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { MemoryService } from './memory.service';
import { RedisProvider } from './redis.provider';

@Module({
  imports: [ConfigModule],
  providers: [MemoryService, RedisProvider],
  exports: [MemoryService],
})
export class MemoryModule {}
