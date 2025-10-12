import { Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { MonicaClient } from './monica.client';
import { MonicaRemindersService } from './reminders/monica-reminders.service';

@Module({
  imports: [ConfigModule],
  providers: [MonicaClient, MonicaRemindersService],
  exports: [MonicaClient, MonicaRemindersService],
})
export class MonicaModule {}
