import pino from 'pino';

// In containers / on servers, stdout is NOT a TTY, so we skip
// pino-pretty and emit raw NDJSON.  Docker (and CasaOS) capture the
// stream and pretty-print it via their own log viewers.  When run
// interactively on a developer machine (TTY present), pino-pretty
// is used for readability.
const useTransport = process.stdout.isTTY;

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  ...(useTransport
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        },
      }
    : {}),
});
