import { Injectable } from '@nestjs/common';
import { format, isValid, parse } from 'date-fns';

const CANDIDATE_FORMATS: ReadonlyArray<string> = [
  'yyyy-MM-dd',
  'dd.MM.yyyy',
  'dd-MM-yyyy',
  'dd/MM/yyyy',
  'MM/dd/yyyy',
  'd MMM yyyy',
  'd MMMM yyyy',
  'yyyy/MM/dd',
];

/**
 * Provides utilities for parsing user-provided dates into a normalized ISO-8601 format.
 */
@Injectable()
export class DatesService {
  /**
   * Attempts to normalize an arbitrary date string into the YYYY-MM-DD format.
   *
   * @param input Raw date as provided by a user or upstream tool.
   * @returns An ISO formatted date when parsing succeeds; otherwise, null.
   */
  normalizeToISO(input: string): string | null {
    const raw = input?.trim();
    if (!raw) {
      return null;
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      return raw;
    }

    for (const formatString of CANDIDATE_FORMATS) {
      const parsed = parse(raw, formatString, new Date());
      if (isValid(parsed)) {
        return format(parsed, 'yyyy-MM-dd');
      }
    }

    return null;
  }
}
