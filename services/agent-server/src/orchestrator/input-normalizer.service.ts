import { Injectable } from '@nestjs/common';
import { NormalizedEventDto } from '../api/transport/dto/normalized-event.dto';

/**
 * Converts normalized transport events into canonical forms for memory and graph consumption.
 */
@Injectable()
export class InputNormalizer {
  /**
   * Produces the textual representation persisted for a given event.
   *
   * @param event Normalized transport event.
   * @returns Canonical text content describing the user input.
   */
  toText(event: NormalizedEventDto): string {
    if (event.type === 'text' && event.text && event.text.trim().length > 0) {
      return event.text.trim();
    }

    if (event.type === 'voice' && event.voiceUrl) {
      return `[voice message received: ${event.voiceUrl}]`;
    }

    if (event.type === 'command' && event.text) {
      const trimmed = event.text.trim();
      return trimmed.length > 0 ? trimmed : '[empty message]';
    }

    return '[empty message]';
  }

  /**
   * Extracts supplemental metadata associated with the event for persistence.
   *
   * @param event Normalized transport event.
   * @returns Metadata object when relevant fields are present; otherwise undefined.
   */
  userMeta(event: NormalizedEventDto): Record<string, unknown> | undefined {
    const meta: Record<string, unknown> = {};

    if (event.voiceUrl) {
      meta.voiceUrl = event.voiceUrl;
    }

    if (event.payload) {
      meta.payload = event.payload;
    }

    if (event.idempotencyKey) {
      meta.idempotencyKey = event.idempotencyKey;
    }

    if (event.connectorId) {
      meta.connectorId = event.connectorId;
    }

    return Object.keys(meta).length > 0 ? meta : undefined;
  }
}
