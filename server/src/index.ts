import { loadConfig } from './config.ts';
import { buildApp } from './app.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const { app } = await buildApp({ config });

  // "::" accepts IPv6 and IPv4 (dual-stack), which Railway's networking requires.
  await app.listen({ host: config.HOST, port: config.PORT });
  app.log.info(
    { quick: config.modes.quick, detailed: config.modes.detailed, transcription: config.OPENAI_TRANSCRIPTION_MODEL },
    'models configured',
  );

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
