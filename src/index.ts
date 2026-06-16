import { loadConfig } from './config';
import { logger } from './logger';
import { WhatsAppClient } from './whatsapp';
import { StateMonitor, PingMonitor, TpsMonitor } from './monitors';
import { LogTailer } from './logTailer';
import { EventDispatcher } from './dispatcher';
import { runListGroupsMode, runPickGroupMode } from './groupDiscovery';

async function main(): Promise<void> {
  const cfg = loadConfig();

  const whatsapp = new WhatsAppClient(cfg);
  await whatsapp.start();

  // Branch into the one-shot discovery modes early - they exit the
  // process when done and never start the monitoring loop.
  if (cfg.mode === 'list-groups') {
    await runListGroupsMode(whatsapp);
    return; // unreachable
  }
  if (cfg.mode === 'pick-group') {
    await runPickGroupMode(whatsapp, cfg);
    return; // unreachable
  }

  // ----- normal daemon mode -----
  logger.info(
    {
      host: cfg.minecraft.host,
      port: cfg.minecraft.port,
      group: cfg.whatsapp.groupJid,
      logPath: cfg.minecraft.logPath,
      rcon: cfg.minecraft.rconPort ? `${cfg.minecraft.rconPort}` : 'off',
    },
    'MineWatch starting up.',
  );

  // Wire the dispatcher BEFORE starting monitors so no event is missed.
  // eslint-disable-next-line no-new
  new EventDispatcher(whatsapp);

  const state = new StateMonitor(cfg);
  const ping = new PingMonitor(cfg);
  const tps = new TpsMonitor(cfg);
  const log = new LogTailer(cfg);

  state.start();
  ping.start();
  await tps.start();
  log.start();

  const shutdown = (sig: string) => {
    logger.warn({ sig }, 'Shutting down MineWatch.');
    state.stop();
    ping.stop();
    tps.stop();
    log.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled promise rejection.');
  });
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'Uncaught exception - daemon will continue running.');
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal error during startup - exiting.');
  process.exit(1);
});
