import { Injectable } from '@nestjs/common';

@Injectable()
export class QuotesClient {
  // TODO: call external API for quotes
  async fetchQuote(_symbol: string): Promise<unknown> {
    return { price: 0 };
  }
}
