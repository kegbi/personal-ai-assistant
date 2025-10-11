import { Injectable } from '@nestjs/common';
import { QuotesClient } from './quotes.client';

@Injectable()
export class QuotesService {
  constructor(private readonly client: QuotesClient) {}

  // TODO: add richer formatting and error handling
  async getQuote(symbol: string): Promise<unknown> {
    return this.client.fetchQuote(symbol);
  }
}
