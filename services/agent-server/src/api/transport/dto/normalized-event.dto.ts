import { IsIn, IsObject, IsOptional, IsString } from 'class-validator';

type AllowedEventType = 'text' | 'voice' | 'command' | 'other';

const ALLOWED_EVENT_TYPES: ReadonlyArray<AllowedEventType> = [
  'text',
  'voice',
  'command',
  'other',
];

/**
 * Normalized representation of a transport event accepted by the HTTP boundary.
 */
export class NormalizedEventDto {
  @IsString()
  connectorId!: string;

  @IsString()
  chatId!: string;

  @IsOptional()
  @IsString()
  userId?: string;

  @IsString()
  @IsIn(ALLOWED_EVENT_TYPES)
  type!: AllowedEventType;

  @IsOptional()
  @IsString()
  text?: string;

  @IsOptional()
  @IsString()
  voiceUrl?: string;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;
}
