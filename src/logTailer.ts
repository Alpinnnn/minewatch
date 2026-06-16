import * as fs from 'fs';
import * as readline from 'readline';
import { logger } from './logger';
import { bus } from './events';
import { AppConfig } from './config';

/**
 * Tails the Minecraft server `logs/latest.log` file and emits
 * PLAYER_JOIN / PLAYER_LEAVE events based on the standard log lines:
 *
 *   [12:34:56] [Server thread/INFO]: PlayerName joined the game
 *   [12:34:56] [Server thread/INFO]: PlayerName left the game
 *
 * The tailer is position-based: it tracks how much of the file it has
 * already processed and resumes from there on every poll cycle, which
 * also handles log rotation (the server archives latest.log to
 * latest.log.1, .2, etc. on startup or when the file grows large).
 */
export class LogTailer {
  private timer: NodeJS.Timeout | null = null;
  private readOffset = 0;
  private lastFileSize = 0;
  private knownPlayers: Set<string> = new Set();

  constructor(private readonly cfg: AppConfig) {}

  start(): void {
    if (!this.cfg.minecraft.logPath) {
      logger.info('MC_LOG_PATH not set - log-based player session detection disabled.');
      return;
    }
    if (!fs.existsSync(this.cfg.minecraft.logPath)) {
      logger.warn(
        { path: this.cfg.minecraft.logPath },
        'Log file does not exist yet - will retry on each tick.',
      );
    }
    // Seed offset to end-of-file so we only process new lines.
    try {
      const stat = fs.statSync(this.cfg.minecraft.logPath);
      this.readOffset = stat.size;
      this.lastFileSize = stat.size;
    } catch {
      this.readOffset = 0;
    }

    this.timer = setInterval(
      () => this.tick().catch((err) => logger.error({ err }, 'LogTailer tick failed.')),
      2000,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    const path = this.cfg.minecraft.logPath;
    if (!path || !fs.existsSync(path)) return;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(path);
    } catch (err) {
      logger.warn({ err, path }, 'Cannot stat log file.');
      return;
    }

    // Detect rotation / truncation - the file got smaller.
    if (stat.size < this.lastFileSize) {
      logger.info(
        { old: this.lastFileSize, new: stat.size },
        'Log file shrank (rotation detected) - resetting offset.',
      );
      this.readOffset = 0;
    }
    this.lastFileSize = stat.size;

    if (stat.size === this.readOffset) return;

    // Read only the new bytes.
    const stream = fs.createReadStream(path, {
      start: this.readOffset,
      end: stat.size - 1,
      encoding: 'utf8',
    });
    this.readOffset = stat.size;

    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    // joined:  ...: <name> joined the game
    // left:    ...: <name> left the game
    // lost connection: ...: <name> lost connection: ...
    const joinMatch = line.match(/^\[[^\]]+\] \[[^\]]+\]: (.+?) joined the game$/);
    if (joinMatch) {
      const name = joinMatch[1].trim();
      this.knownPlayers.add(name);
      void bus.emit({
        type: 'PLAYER_JOIN',
        timestamp: new Date(),
        payload: { player: name, onlineCount: this.knownPlayers.size },
      });
      return;
    }
    const leaveMatch = line.match(
      /^\[[^\]]+\] \[[^\]]+\]: (.+?) (left the game|lost connection[^\n]*)$/,
    );
    if (leaveMatch) {
      const name = leaveMatch[1].trim();
      this.knownPlayers.delete(name);
      void bus.emit({
        type: 'PLAYER_LEAVE',
        timestamp: new Date(),
        payload: { player: name, onlineCount: this.knownPlayers.size },
      });
    }
  }
}
