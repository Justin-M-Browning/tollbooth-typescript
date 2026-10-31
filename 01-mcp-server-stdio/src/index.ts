import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createCustomerServer, SERVER_NAME, SERVER_VERSION } from './server.js';
import { logger, enforceStdioIsolation } from './logger.js';

async function main(): Promise<void> {
  enforceStdioIsolation();

  logger.info(`Starting ${SERVER_NAME} v${SERVER_VERSION} on stdio transport...`);

  const server = createCustomerServer();
  const transport = new StdioServerTransport();

  transport.onerror = (err) => {
    logger.error('StdioServerTransport error encountered:', err);
  };

  transport.onclose = () => {
    logger.info('StdioServerTransport connection closed');
    process.exit(0);
  };

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    try {
      await server.close();
      await transport.close();
      logger.info('Server shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error('Error during shutdown:', err);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception in process:', err);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled Promise Rejection in process:', reason);
  });

  await server.connect(transport);
  logger.info(`${SERVER_NAME} successfully running and listening on stdio`);
}

main().catch((err) => {
  logger.error('Fatal initialization error in main():', err);
  process.exit(1);
});

