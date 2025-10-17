import { Injectable } from '@nestjs/common';
import { NormalizedEventDto } from '../api/transport/dto/normalized-event.dto';
import { MemoryService } from '../memory/memory.service';
import { AgentResponseDto } from '../transport/dto/agent-response.dto';

/**
 * Routes command-style events to canned responses while coordinating memory operations.
 */
@Injectable()
export class CommandRouter {
  constructor(private readonly memoryService: MemoryService) {}

  /**
   * Executes the command provided by the event and returns the appropriate response.
   *
   * @param event Normalized event enriched with connector metadata.
   * @returns Response that should be delivered to the user.
   */
  async handle(event: NormalizedEventDto): Promise<AgentResponseDto> {
    const rawText = (event.text ?? '').trim();
    const command = rawText.split(' ')[0]?.toLowerCase() ?? '';

    switch (command) {
      case '/start': {
        await this.memoryService.clear(event.chatId);
        return {
          chatId: event.chatId,
          text: 'Hello! I am your personal AI assistant. Ask me to remember contacts, update details, or just chat.',
        };
      }
      case '/clear': {
        await this.memoryService.clear(event.chatId);
        return {
          chatId: event.chatId,
          text: 'Cleared recent conversation memory for this chat.',
        };
      }
      case '/help': {
        return {
          chatId: event.chatId,
          text:
            'Try:\n' +
            '• “Remember that Alice is my designer friend.”\n' +
            '• “Set Alice’s birthday to 1991-05-14.”\n' +
            '• “Who is Alice?”',
        };
      }
      default:
        return {
          chatId: event.chatId,
          text: `Unknown command ${command}. Available: /start, /help, /clear.`,
        };
    }
  }
}
