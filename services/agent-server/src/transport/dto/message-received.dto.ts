import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  ValidateIf,
} from 'class-validator';

export class MessageReceivedDto {
  @IsString()
  chatId!: string;

  @IsString()
  userId!: string;

  @IsOptional()
  @IsString()
  text?: string;

  @IsOptional()
  @IsString()
  voiceUrl?: string;

  @IsOptional()
  @IsBoolean()
  isCommand?: boolean;

  @ValidateIf((o) => o.isCommand)
  @IsString()
  command?: string;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;
}
