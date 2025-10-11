import { Injectable } from '@nestjs/common';

@Injectable()
export class ToolRouterNode {
  // TODO: invoke domain tools via dependency injection
  async execute(input: unknown): Promise<unknown> {
    return input;
  }
}
