import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-base';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';

export interface TracingOptions {
  exporter: 'console' | 'otlp';
  endpoint?: string;
}

let sdk: NodeSDK | null = null;
let loggerConfigured = false;

const configureDiagLogger = (): void => {
  if (loggerConfigured) {
    return;
  }

  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);
  loggerConfigured = true;
};

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  return typeof Reflect.get(value, 'then') === 'function';
};

const createExporter = (options: TracingOptions) => {
  if (options.exporter === 'otlp') {
    return new OTLPTraceExporter(
      options.endpoint
        ? {
            url: options.endpoint,
          }
        : undefined,
    );
  }

  return new ConsoleSpanExporter();
};

/**
 * Bootstraps the OpenTelemetry Node SDK when tracing is enabled.
 *
 * @param options Tracing configuration sourced from environment variables.
 * @returns Started Node SDK instance.
 */
export const initializeTracing = async (
  options: TracingOptions,
): Promise<NodeSDK> => {
  if (sdk) {
    return sdk;
  }

  configureDiagLogger();

  const nodeSdk = new NodeSDK({
    traceExporter: createExporter(options),
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: 'agent-server',
    }),
  });

  const startResult = nodeSdk.start();
  if (isPromiseLike(startResult)) {
    await startResult;
  }
  sdk = nodeSdk;
  return nodeSdk;
};

/**
 * Stops the OpenTelemetry SDK gracefully.
 */
export const shutdownTracing = async (): Promise<void> => {
  if (!sdk) {
    return;
  }

  try {
    await sdk.shutdown();
  } finally {
    sdk = null;
  }
};
