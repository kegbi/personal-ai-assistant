import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppConfigService } from './config/config.service';
import { JsonLogger } from './common/json-logger.service';
import { initializeTracing, shutdownTracing } from './common/tracing';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  const config = app.get(AppConfigService);
  if (config.tracing.enabled) {
    await initializeTracing({
      exporter: config.tracing.exporter,
      endpoint: config.tracing.otlpEndpoint,
    });
  }

  if (config.logging.format === 'json') {
    const logger = app.get(JsonLogger);
    app.useLogger(logger);
  }

  app.enableShutdownHooks();

  let shuttingDown = false;
  const handleShutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    let exitCode = 0;

    try {
      await app.close();
    } catch (error) {
      exitCode = 1;
      console.error(`Nest application shutdown failed after ${signal}`, error);
    }

    if (config.tracing.enabled) {
      try {
        await shutdownTracing();
      } catch (error) {
        exitCode = 1;
        console.error('Tracing shutdown failed', error);
      }
    }

    process.exit(exitCode);
  };

  const signals: Array<NodeJS.Signals> = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    process.once(signal, () => {
      void handleShutdown(signal);
    });
  }

  app.flushLogs();
  await app.listen(config.app.port);
}
void bootstrap().catch((error) => {
  console.error('Application bootstrap failed', error);
  void shutdownTracing().finally(() => {
    process.exit(1);
  });
});
