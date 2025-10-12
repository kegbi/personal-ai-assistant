import { Module } from '@nestjs/common';
import { RemindersService } from './reminders.service';
import { RemindersController } from './reminders.controller';
import { MonicaModule } from '../../integrations/monica/monica.module';
import { ConfigModule } from '../../config/config.module';

@Module({
  imports: [MonicaModule, ConfigModule],
  controllers: [RemindersController],
  providers: [RemindersService],
  exports: [RemindersService],
})
export class RemindersModule {}
