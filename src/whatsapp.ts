import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  WASocket,
  AnyMessageContent,
  BaileysEventMap,
  GroupMetadata,
  Browsers,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as fs from 'fs';
import * as path from 'path';
import * as QRCode from 'qrcode';
import { logger } from './logger';
import { AppConfig } from './config';

export interface GroupEntry {
  jid: string;
  subject: string;
  participants: number;
}

export class WhatsAppClient {
  private sock: WASocket | null = null;
  private connected = false;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 50;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly openResolvers: Array<() => void> = [];

  constructor(private readonly cfg: AppConfig) {}

  async start(): Promise<void> {
    if (!fs.existsSync(this.cfg.whatsapp.authDir)) {
      fs.mkdirSync(this.cfg.whatsapp.authDir, { recursive: true });
    }

    await this.connect();

    this.sock?.ev.on('messages.upsert', (m: BaileysEventMap['messages.upsert']) => {
      // The daemon is one-way; we only care about outgoing payloads.
      // Hook is kept for future bidirectional features.
      void m;
    });
  }

  /**
   * Wait for the underlying socket to be fully open and authenticated.
   * Used by the one-shot group discovery modes.
   */
  async waitForOpen(timeoutMs = 300_000): Promise<void> {
    if (this.connected && this.sock) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for WhatsApp connection.`));
      }, timeoutMs);
      this.openResolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * Fetch every group the connected account is a member of.  Returns a
   * flat list of `{ jid, subject, participants }` sorted by subject.
   */
  async listGroups(): Promise<GroupEntry[]> {
    if (!this.sock || !this.connected) {
      throw new Error('WhatsApp is not connected.');
    }
    const all = (await this.sock.groupFetchAllParticipating()) as Record<
      string,
      GroupMetadata
    >;
    const list: GroupEntry[] = [];
    for (const [jid, meta] of Object.entries(all)) {
      if (!jid.endsWith('@g.us')) continue; // skip non-group nodes
      list.push({
        jid,
        subject: meta.subject ?? '(no subject)',
        participants: Array.isArray(meta.participants) ? meta.participants.length : 0,
      });
    }
    list.sort((a, b) => a.subject.localeCompare(b.subject));
    return list;
  }

  private async connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.cfg.whatsapp.authDir);

    this.sock = makeWASocket({
      auth: state,
      // Note: do NOT pass `printQRInTerminal` here - that option was
      // deprecated in Baileys 6.6+.  We surface the QR in the
      // `connection.update` handler below; in a TTY the user can copy
      // it, and in Docker/CasaOS logs the operator pipes the daemon
      // output through any external QR tool they like.
      logger: logger.child({ module: 'baileys' }) as any,
      // Use a real desktop-Chrome fingerprint so WhatsApp's anti-abuse
      // layer accepts the registration.  A custom name like
      // `['MineWatch', 'Daemon', '1.0.0']` looks suspicious and gets
      // rejected with status 405 before a QR is even issued.
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        // Surface the raw QR data on stdout.  Operators can pipe it
        // through `node -e "..."` or any QR generator to scan.
        // In CasaOS / Docker logs the QR string is searchable text.
        process.stdout.write(
          '\n========================================\n' +
            'WhatsApp QR code (scan with Linked Devices):\n' +
            qr +
            '\n========================================\n',
        );
        // Also render the QR as a PNG inside the mounted auth volume
        // so an operator without a TTY (typical Docker / CasaOS
        // setup) can copy it out and scan it with the phone.  The
        // file path is logged for easy retrieval.
        const qrPngPath = path.join(this.cfg.whatsapp.authDir, 'qr.png');
        QRCode.toFile(qrPngPath, qr, { type: 'png', width: 512, margin: 2 })
          .then(() => {
            logger.info(
              { path: qrPngPath },
              'QR code rendered to PNG inside the auth volume - copy this file to a device that can display it, then scan with WhatsApp Linked Devices.',
            );
          })
          .catch((err) => {
            logger.warn({ err }, 'Failed to render QR as PNG; only the raw string above is available.');
          });
      }
      if (connection === 'open') {
        this.connected = true;
        this.reconnectAttempts = 0;
        logger.info('WhatsApp connection established.');
        // Resolve any pending waitForOpen() promises.  Drain the queue
        // (rather than call each individually) so a future reconnect
        // after a transient drop will not re-resolve stale waiters.
        while (this.openResolvers.length > 0) {
          const fn = this.openResolvers.shift();
          try {
            fn?.();
          } catch {
            /* ignore */
          }
        }
      } else if (connection === 'close') {
        this.connected = false;
        const status = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = status !== DisconnectReason.loggedOut;
        logger.warn(
          { status, shouldReconnect, reason: lastDisconnect?.error?.message },
          'WhatsApp connection closed.',
        );
        if (shouldReconnect) {
          this.scheduleReconnect();
        } else {
          logger.error('Logged out by WhatsApp - delete auth dir and re-scan QR to recover.');
          // Auto-regenerate the session by wiping creds; the next connect()
          // call will print a fresh QR code.
          this.regenerateSession();
        }
      } else if (connection === 'connecting') {
        logger.info('WhatsApp connecting...');
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max reconnect attempts reached. Regenerating session.');
      this.regenerateSession();
      return;
    }
    this.reconnectAttempts += 1;
    // Exponential backoff capped at 30s.
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempts, 5));
    logger.info(`Reconnecting to WhatsApp in ${delay}ms (attempt ${this.reconnectAttempts}).`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch (err) {
        logger.error({ err }, 'Reconnect attempt failed.');
        this.scheduleReconnect();
      }
    }, delay);
  }

  private async regenerateSession(): Promise<void> {
    logger.warn('Regenerating WhatsApp session - existing auth will be wiped.');
    try {
      // Best-effort close of the current socket.
      try {
        this.sock?.end(undefined);
      } catch {
        /* ignore */
      }
      this.sock = null;
      this.connected = false;
      this.reconnectAttempts = 0;

      // Wipe the auth dir.  The next start() will produce a new QR.
      if (fs.existsSync(this.cfg.whatsapp.authDir)) {
        for (const f of fs.readdirSync(this.cfg.whatsapp.authDir)) {
          fs.rmSync(path.join(this.cfg.whatsapp.authDir, f), { recursive: true, force: true });
        }
      }
      await this.connect();
    } catch (err) {
      logger.error({ err }, 'Session regeneration failed.');
      // Try again in 30s.
      setTimeout(() => this.regenerateSession(), 30_000);
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Send a text message to the configured group.  Silently no-ops if the
   * socket is not currently connected so the daemon never crashes on a
   * transient outage.
   */
  async sendText(message: string): Promise<void> {
    if (!this.sock || !this.connected) {
      logger.warn({ message }, 'WhatsApp not connected - dropping message.');
      return;
    }
    // In daemon mode WHATSAPP_GROUP_JID is required by loadConfig(); in
    // list-groups / pick-group modes sendText() is never called.
    const jid = this.cfg.whatsapp.groupJid;
    if (!jid) {
      logger.error('sendText() called without a configured WHATSAPP_GROUP_JID.');
      return;
    }
    try {
      const payload: AnyMessageContent = { text: message };
      await this.sock.sendMessage(jid, payload);
    } catch (err) {
      logger.error({ err, message }, 'Failed to send WhatsApp message.');
    }
  }
}
