import { status as mcStatus, JavaStatusResponse } from 'minecraft-server-util';
import { RCON } from './rcon';
import { logger } from './logger';
import { bus } from './events';
import { AppConfig } from './config';

/**
 * Polls the Minecraft server-list-ping protocol on a fixed interval and
 * emits SERVER_DOWN / SERVER_UP events based on a configurable failure
 * threshold (avoids flapping on a single dropped packet).
 */
export class StateMonitor {
  private timer: NodeJS.Timeout | null = null;
  private failStreak = 0;
  private lastIsUp = false;
  private firstCheck = true;

  constructor(private readonly cfg: AppConfig) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => this.tick().catch((err) => logger.error({ err }, 'StateMonitor tick failed.')),
      this.cfg.thresholds.pollIntervalMs,
    );
    // Run an immediate first tick so the daemon reflects current state.
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    let up = false;
    let sample: JavaStatusResponse | null = null;
    try {
      sample = await mcStatus(this.cfg.minecraft.host, this.cfg.minecraft.port, {
        timeout: Math.max(2000, this.cfg.thresholds.pollIntervalMs - 1000),
        enableSRV: true,
      });
      up = true;
    } catch {
      up = false;
    }

    if (up) {
      if (this.failStreak !== 0) {
        logger.info(
          { failStreak: this.failStreak },
          'Server recovered after failure streak.',
        );
      }
      this.failStreak = 0;
      if (!this.lastIsUp || this.firstCheck) {
        this.lastIsUp = true;
        this.firstCheck = false;
        const playersOnline = sample?.players?.online ?? 0;
        const playersMax = sample?.players?.max ?? 0;
        const motd = (sample?.motd?.clean ?? '').toString().slice(0, 80);
        await bus.emit({
          type: 'SERVER_UP',
          timestamp: new Date(),
          payload: {
            host: this.cfg.minecraft.host,
            port: this.cfg.minecraft.port,
            playersOnline,
            playersMax,
            motd,
            version: sample?.version?.name ?? 'unknown',
          },
        });
      }
    } else {
      this.failStreak += 1;
      if (this.failStreak >= this.cfg.thresholds.downFailCount && this.lastIsUp) {
        this.lastIsUp = false;
        await bus.emit({
          type: 'SERVER_DOWN',
          timestamp: new Date(),
          payload: {
            host: this.cfg.minecraft.host,
            port: this.cfg.minecraft.port,
            failStreak: this.failStreak,
          },
        });
      }
    }
  }
}

/**
 * Samples ping latency at a separate interval and emits HIGH_PING /
 * PING_NORMALIZED events based on a configurable failure threshold.
 */
export class PingMonitor {
  private timer: NodeJS.Timeout | null = null;
  private highStreak = 0;
  private isHigh = false;

  constructor(private readonly cfg: AppConfig) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => this.tick().catch((err) => logger.error({ err }, 'PingMonitor tick failed.')),
      this.cfg.thresholds.latencyIntervalMs,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    let latency: number | null = null;
    try {
      const res = await mcStatus(this.cfg.minecraft.host, this.cfg.minecraft.port, {
        timeout: Math.max(2000, this.cfg.thresholds.latencyIntervalMs - 1000),
        enableSRV: true,
      });
      latency = res.roundTripLatency;
    } catch {
      // Server unreachable - let StateMonitor handle the "down" case.
      return;
    }
    if (latency === null) return;

    const high = latency > this.cfg.thresholds.pingThresholdMs;
    if (high) {
      this.highStreak += 1;
      if (
        this.highStreak >= this.cfg.thresholds.highPingFailCount &&
        !this.isHigh
      ) {
        this.isHigh = true;
        await bus.emit({
          type: 'HIGH_PING',
          timestamp: new Date(),
          payload: {
            latencyMs: latency,
            thresholdMs: this.cfg.thresholds.pingThresholdMs,
            host: this.cfg.minecraft.host,
            port: this.cfg.minecraft.port,
          },
        });
      }
    } else {
      if (this.isHigh) {
        this.isHigh = false;
        await bus.emit({
          type: 'PING_NORMALIZED',
          timestamp: new Date(),
          payload: { latencyMs: latency },
        });
      }
      this.highStreak = 0;
    }
  }
}

/**
 * Polls TPS via RCON (`tps` command, supported by Paper / Spigot / Purpur
 * and forks).  Falls back gracefully if RCON is not configured or the
 * command is not recognized.
 */
export class TpsMonitor {
  private timer: NodeJS.Timeout | null = null;
  private isLow = false;
  private rcon: RCON | null = null;
  private rconConnected = false;

  constructor(private readonly cfg: AppConfig) {}

  async start(): Promise<void> {
    if (!this.cfg.minecraft.rconPort || !this.cfg.minecraft.rconPassword) {
      logger.info('RCON not configured - TPS monitor disabled.');
      return;
    }
    this.rcon = new RCON(
      this.cfg.minecraft.host,
      this.cfg.minecraft.rconPort,
      this.cfg.minecraft.rconPassword,
    );
    await this.connectRcon();
    this.timer = setInterval(
      () => this.tick().catch((err) => logger.error({ err }, 'TpsMonitor tick failed.')),
      this.cfg.thresholds.latencyIntervalMs,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.rcon?.disconnect();
  }

  private async connectRcon(): Promise<void> {
    if (!this.rcon) return;
    try {
      await this.rcon.connect();
      this.rconConnected = true;
      logger.info('RCON connected.');
    } catch (err) {
      this.rconConnected = false;
      logger.warn({ err }, 'RCON connection failed - will retry on next tick.');
    }
  }

  private async tick(): Promise<void> {
    if (!this.rcon) return;
    if (!this.rconConnected) {
      await this.connectRcon();
      if (!this.rconConnected) return;
    }
    let response: string;
    try {
      response = await this.rcon.send('tps');
    } catch (err) {
      this.rconConnected = false;
      logger.warn({ err }, 'RCON `tps` command failed - will reconnect.');
      return;
    }

    const tps = this.parseTps(response);
    if (tps === null) {
      // Probably vanilla server without a `tps` command.
      logger.debug({ response }, 'Could not parse TPS from RCON response.');
      return;
    }

    const low = tps < this.cfg.thresholds.tpsThreshold;
    if (low && !this.isLow) {
      this.isLow = true;
      await bus.emit({
        type: 'LOW_TPS',
        timestamp: new Date(),
        payload: {
          tps,
          threshold: this.cfg.thresholds.tpsThreshold,
        },
      });
    } else if (!low && this.isLow) {
      this.isLow = false;
      await bus.emit({
        type: 'TPS_NORMALIZED',
        timestamp: new Date(),
        payload: { tps },
      });
    }
  }

  /**
   * Parse the typical Paper TPS line, e.g.
   *   "TPS from last 1m, 5m, 15m: 20.0, 19.98, 19.95"
   * Returns the 1-minute value, or null on failure.
   */
  private parseTps(response: string): number | null {
    const m = response.match(/TPS\s*from\s*last\s*1m.*?:\s*([\d.]+)/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    return Number.isFinite(n) ? n : null;
  }
}
