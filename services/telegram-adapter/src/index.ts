import process from 'node:process';
import { loadConfig } from './config';
import { AgentClient } from './agent-client';
import { TelegramBridge } from './telegram-bridge';
import { startHealthServer } from './health';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const agentClient = new AgentClient(config.agentBaseUrl, {
    timeoutMs: config.agentTimeoutMs,
    authToken: config.agentAuthToken,
  });

  const bridge = new TelegramBridge(config, agentClient);
  await bridge.start();

  const server = await startHealthServer(config.healthPort, () => bridge.getStatus());
  console.log(
    `[telegram-bridge] Health endpoint listening on :${config.healthPort}/health`,
  );

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    console.log(`[telegram-bridge] Received ${signal}, shutting down...`);
    await bridge.stop();

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    process.exit(0);
  };

  const handleSignal = (signal: NodeJS.Signals) => {
    void shutdown(signal);
  };

  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);
}

bootstrap().catch((error) => {
  console.error('[telegram-bridge] Fatal error:', error);
  process.exit(1);
});
