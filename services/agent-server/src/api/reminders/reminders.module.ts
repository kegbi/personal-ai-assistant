import { Module } from '@nestjs/common';
import { RemindersService } from './reminders.service';
import { RemindersController } from './reminders.controller';
import { MonicaModule } from '../../integrations/monica/monica.module';
import { ConfigModule } from '../../config/config.module';
import { CommonModule } from '../../common/common.module';

@Module({
  imports: [MonicaModule, ConfigModule, CommonModule],
  controllers: [RemindersController],
  providers: [RemindersService],
  exports: [RemindersService],
})
export class RemindersModule {}
