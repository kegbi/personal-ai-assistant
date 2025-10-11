import { Module } from '@nestjs/common';
import { QuotesService } from './quotes.service';
import { QuotesClient } from './quotes.client';

@Module({
  providers: [QuotesService, QuotesClient],
  exports: [QuotesService],
})
export class QuotesModule {}
