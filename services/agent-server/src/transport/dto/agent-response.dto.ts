import {
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class AgentResponseMeta {
  @IsOptional()
  @IsString()
  tool?: string;

  @IsOptional()
  @IsObject()
  args?: Record<string, unknown>;

  @IsOptional()
  @IsNumber()
  elapsedMs?: number;
}

export class AgentResponseDto {
  @IsString()
  chatId!: string;

  @IsString()
  text!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AgentResponseMeta)
  meta?: AgentResponseMeta;
}
