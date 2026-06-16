import { bus, MinewatchEvent, EventType } from './events';
import { WhatsAppClient } from './whatsapp';
import { logger } from './logger';

/**
 * Formats a MinewatchEvent into a short WhatsApp-friendly text payload
 * and dispatches it via the WhatsAppClient.  Emoji are used as visual
 * markers so the group feed is scannable at a glance.
 */
export class EventDispatcher {
  private readonly cooldownMs: Partial<Record<EventType, number>> = {
    // Re-emit only after 60s for events that could flap.
    HIGH_PING: 60_000,
    LOW_TPS: 60_000,
  };
  private lastSentAt: Partial<Record<EventType, number>> = {};

  constructor(private readonly whatsapp: WhatsAppClient) {
    this.bind();
  }

  private bind(): void {
    const types: EventType[] = [
      'SERVER_DOWN',
      'SERVER_UP',
      'HIGH_PING',
      'PING_NORMALIZED',
      'LOW_TPS',
      'TPS_NORMALIZED',
      'PLAYER_JOIN',
      'PLAYER_LEAVE',
    ];
    for (const t of types) {
      bus.on(t, (e) => this.handle(e));
    }
  }

  private async handle(event: MinewatchEvent): Promise<void> {
    const now = Date.now();
    const cd = this.cooldownMs[event.type];
    if (cd) {
      const last = this.lastSentAt[event.type] ?? 0;
      if (now - last < cd) {
        logger.debug({ type: event.type }, 'Suppressed by cooldown.');
        return;
      }
    }
    this.lastSentAt[event.type] = now;

    const text = this.format(event);
    if (!text) return;
    logger.info({ type: event.type, text }, 'Dispatching alert.');
    await this.whatsapp.sendText(text);
  }

  private format(e: MinewatchEvent): string | null {
    const ts = e.timestamp.toISOString().replace('T', ' ').slice(0, 19);
    switch (e.type) {
      case 'SERVER_DOWN': {
        const p = e.payload as { host: string; port: number; failStreak: number };
        return `🔴 *SERVER DOWN*\nThe Minecraft server at \`${p.host}:${p.port}\` is unreachable.\nConsecutive failed checks: ${p.failStreak}\nTime: ${ts} UTC`;
      }
      case 'SERVER_UP': {
        const p = e.payload as {
          host: string;
          port: number;
          playersOnline: number;
          playersMax: number;
          motd: string;
          version: string;
        };
        return `🟢 *SERVER UP*\nMinecraft server \`${p.host}:${p.port}\` is online.\nVersion: ${p.version}\nPlayers: ${p.playersOnline}/${p.playersMax}\nMOTD: ${p.motd || '(none)'}\nTime: ${ts} UTC`;
      }
      case 'HIGH_PING': {
        const p = e.payload as {
          latencyMs: number;
          thresholdMs: number;
          host: string;
          port: number;
        };
        return `⚠️ *HIGH PING*\nServer latency: *${p.latencyMs}ms* (threshold ${p.thresholdMs}ms).\nHost: \`${p.host}:${p.port}\`\nTime: ${ts} UTC`;
      }
      case 'PING_NORMALIZED': {
        const p = e.payload as { latencyMs: number };
        return `✅ *PING NORMAL*\nServer latency back to normal: ${p.latencyMs}ms.\nTime: ${ts} UTC`;
      }
      case 'LOW_TPS': {
        const p = e.payload as { tps: number; threshold: number };
        return `🐢 *LOW TPS*\nServer TPS dropped to *${p.tps.toFixed(2)}* (threshold ${p.threshold}). Possible overload.\nTime: ${ts} UTC`;
      }
      case 'TPS_NORMALIZED': {
        const p = e.payload as { tps: number };
        return `⚡ *TPS NORMAL*\nServer TPS recovered: ${p.tps.toFixed(2)}.\nTime: ${ts} UTC`;
      }
      case 'PLAYER_JOIN': {
        const p = e.payload as { player: string; onlineCount: number };
        return `➡️ *PLAYER JOINED*\n*${p.player}* joined the game. (${p.onlineCount} online)\nTime: ${ts} UTC`;
      }
      case 'PLAYER_LEAVE': {
        const p = e.payload as { player: string; onlineCount: number };
        return `⬅️ *PLAYER LEFT*\n*${p.player}* left the game. (${p.onlineCount} online)\nTime: ${ts} UTC`;
      }
      default:
        return null;
    }
  }
}
