import { Injectable, Logger } from '@nestjs/common';
import { MessagesAnnotation } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { StructuredToolInterface, tool } from '@langchain/core/tools';
import { z } from 'zod';
import { RunnableConfig } from '@langchain/core/runnables';
import { ContactsService } from '../../../tools/contacts/contacts.service';
import { MemoryService } from '../../../memory/memory.service';

@Injectable()
export class ToolRouterNode {
  private readonly logger = new Logger(ToolRouterNode.name);
  private readonly toolNode: ToolNode;
  readonly tools: StructuredToolInterface[];

  constructor(
    private readonly contactsService: ContactsService,
    private readonly memoryService: MemoryService,
  ) {
    this.tools = [
      tool(
        async ({ name, birthday, contactId }, config?: RunnableConfig) => {
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
        async ({ contactId, birthday }, config?: RunnableConfig) => {
          try {
            const chatId = this.resolveContactChatId(config);
            const targetId =
              contactId?.trim() ||
              ((await this.memoryService.getHandle(chatId, 'last_contact_id')) as
                | string
                | undefined);

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
      return await this.toolNode.invoke(input, config);
    } catch (error) {
      this.logger.error(
        'Tool execution failed',
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  private extractChatId(config?: RunnableConfig): string {
    const chatId = config?.configurable?.chatId;
    if (!chatId || typeof chatId !== 'string') {
      throw new Error('chatId missing in tool invocation context');
    }
    return chatId;
  }

  private resolveContactChatId(config?: RunnableConfig): string {
    return this.extractChatId(config);
  }
}
