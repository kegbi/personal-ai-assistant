/**
 * Summary describing the terminal tool invocation result used for transport-level metadata.
 */
export interface ToolInvocationMeta {
  readonly name: string;
  readonly args: Record<string, unknown>;
}
