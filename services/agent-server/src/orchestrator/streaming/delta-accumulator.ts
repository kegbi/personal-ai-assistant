/**
 * Tracks assistant message text fragments and computes incremental deltas.
 */
export class DeltaAccumulator {
  private readonly lastByKey = new Map<string, string>();

  /**
   * Calculates the delta between the previous and next assistant text.
   *
   * @param key Stable assistant message identifier from LangGraph stream entries.
   * @param nextText Full text emitted for the message in the current chunk.
   * @returns Delta string to stream to clients.
   */
  computeDelta(key: string, nextText: string): string {
    const previous = this.lastByKey.get(key);
    if (previous === undefined) {
      this.lastByKey.set(key, nextText);
      return nextText;
    }

    if (nextText.startsWith(previous)) {
      const delta = nextText.slice(previous.length);
      this.lastByKey.set(key, nextText);
      return delta;
    }

    this.lastByKey.set(key, nextText);
    return nextText;
  }
}
