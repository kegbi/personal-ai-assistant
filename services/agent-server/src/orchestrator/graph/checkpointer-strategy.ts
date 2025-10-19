/**
 * Strategy contract describing how LangGraph checkpointer support is toggled.
 */
export interface CheckpointerStrategy {
  /**
   * Indicates whether the checkpointer should be enabled for the current run.
   *
   * @returns True when the checkpointer must be activated.
   */
  isEnabled(): boolean;
}

/**
 * Injection token used to supply a {@link CheckpointerStrategy} implementation.
 */
export const CHECKPOINTER_STRATEGY = Symbol('CHECKPOINTER_STRATEGY');
