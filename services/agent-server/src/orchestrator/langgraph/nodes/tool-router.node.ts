import { Injectable, Logger } from '@nestjs/common';
import { MessagesAnnotation } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { StructuredToolInterface, tool } from '@langchain/core/tools';
import { z } from 'zod';
import { RunnableConfig } from '@langchain/core/runnables';
import { ContactsService } from '../../../tools/contacts/contacts.service';
import { MemoryService } from '../../../memory/memory.service';
import { RemindersService } from '../../../api/reminders/reminders.service';

interface CreateContactArgs {
  name: string;
  birthday?: string;
  contactId?: string;
}

interface SetBirthdayArgs {
  contactId?: string;
  birthday: string;
}

@Injectable()
export class ToolRouterNode {
  private readonly logger = new Logger(ToolRouterNode.name);
  private readonly toolNode: ToolNode;
  readonly tools: StructuredToolInterface[];

  constructor(
    private readonly contactsService: ContactsService,
    private readonly memoryService: MemoryService,
    private readonly remindersService: RemindersService,
  ) {
    this.tools = [
      tool(
        async (
          { name, birthday, contactId }: CreateContactArgs,
          config?: RunnableConfig,
        ) => {
          try {
            const chatId = this.extractChatId(config);
            const contact = await this.contactsService.createContact(chatId, {
              name,
              birthday,
              id: contactId,
            });

            await this.memoryService.setHandle(
              chatId,
              'last_contact_id',
              contact.id,
            );

            return `Saved contact ${contact.name} (id: ${contact.id})${
              contact.birthday ? ` – birthday ${contact.birthday}` : ''
            }.`;
          } catch (error) {
            const reason =
              error instanceof Error ? error.message : String(error);
            this.logger.warn(`contacts_create failed: ${reason}`);
            return `Unable to save contact: ${
              error instanceof Error ? error.message : error
            }`;
          }
        },
        {
          name: 'contacts_create',
          description:
            'Create a personal contact for the current chat. Provide name and optional birthday (ISO date). Returns the stored contact id.',
          schema: z.object({
            name: z.string().min(1, 'Name is required'),
            birthday: z
              .string()
              .optional()
              .describe('Birthday in ISO format (YYYY-MM-DD) if known'),
            contactId: z
              .string()
              .optional()
              .describe('Optional pre-defined identifier, otherwise generated'),
          }),
        },
      ),
      tool(
        async (_args: Record<string, never>, config?: RunnableConfig) => {
          try {
            this.extractChatId(config);
            const digest =
              await this.remindersService.getRemindersTodayMessage();
            return digest.message;
          } catch (error) {
            const reason =
              error instanceof Error ? error.message : String(error);
            this.logger.warn(`reminders_get_upcoming failed: ${reason}`);
            return `Unable to fetch upcoming reminders: ${
              error instanceof Error ? error.message : error
            }`;
          }
        },
        {
          name: 'reminders_get_upcoming',
          description:
            'Retrieve upcoming reminders/events for all contacts. Returns a formatted digest.',
          schema: z.object({}),
        },
      ),
      tool(
        async (
          { contactId, birthday }: SetBirthdayArgs,
          config?: RunnableConfig,
        ) => {
          try {
            const chatId = this.resolveContactChatId(config);
            const recentHandle = await this.memoryService.getHandle(
              chatId,
              'last_contact_id',
            );
            const recentContactId =
              typeof recentHandle === 'string' ? recentHandle : undefined;
            const targetId = contactId?.trim() || recentContactId;

            if (!targetId) {
              return 'No contact id provided and no recent contact is known.';
            }

            const updated = await this.contactsService.setBirthday(
              chatId,
              targetId,
              birthday,
            );

            return `Updated birthday for ${updated.name} (id: ${updated.id}) to ${updated.birthday}.`;
          } catch (error) {
            const reason =
              error instanceof Error ? error.message : String(error);
            this.logger.warn(`contacts_set_birthday failed: ${reason}`);
            return `Unable to update birthday: ${
              error instanceof Error ? error.message : error
            }`;
          }
        },
        {
          name: 'contacts_set_birthday',
          description:
            'Update the birthday for an existing contact. Use when the user provides a date for a known contact.',
          schema: z.object({
            contactId: z
              .string()
              .optional()
              .describe(
                'Contact identifier. Prefer using the most recent contact (handle last_contact_id) if unspecified.',
              ),
            birthday: z
              .string()
              .min(4, 'birthday is required')
              .describe('Birthday in ISO format (YYYY-MM-DD)'),
          }),
        },
      ),
    ];

    this.toolNode = new ToolNode(this.tools);
  }

  async execute(
    input: typeof MessagesAnnotation.State,
    config?: RunnableConfig,
  ): Promise<Partial<typeof MessagesAnnotation.State>> {
    try {
      const result: unknown = await this.toolNode.invoke(input, config);
      if (!this.isPartialMessagesState(result)) {
        throw new Error('Tool node returned an invalid state payload.');
      }
      return result;
    } catch (error) {
      this.logger.error(
        'Tool execution failed',
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  private extractChatId(config?: RunnableConfig): string {
    const configurable = config?.configurable;
    const chatId =
      this.isRecord(configurable) && typeof configurable.chatId === 'string'
        ? configurable.chatId
        : undefined;

    if (!chatId) {
      throw new Error('chatId missing in tool invocation context');
    }
    return chatId;
  }

  private resolveContactChatId(config?: RunnableConfig): string {
    return this.extractChatId(config);
  }

  /**
   * Verifies the tool execution output is a partial LangGraph messages state.
   *
   * @param value Candidate value returned by the tool router.
   * @returns True when the payload is a non-null record.
   */
  private isPartialMessagesState(
    value: unknown,
  ): value is Partial<typeof MessagesAnnotation.State> {
    return this.isRecord(value);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
