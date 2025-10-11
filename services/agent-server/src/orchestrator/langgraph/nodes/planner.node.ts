import { Injectable } from '@nestjs/common';

@Injectable()
export class PlannerNode {
  // TODO: implement planning logic with LangGraph
  async execute(input: unknown): Promise<unknown> {
    return input;
  }
}
