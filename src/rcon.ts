import * as net from 'net';
import { logger } from './logger';

/**
 * Minimal Minecraft-compatible RCON client.  Implements just enough of
 * the Source RCON protocol (https://developer.valvesoftware.com/wiki/Source_RCON_Protocol)
 * to send commands and read responses.
 *
 * We use a small custom implementation instead of a heavyweight library
 * because RCON traffic is trivial: one TCP socket, length-prefixed
 * request/response packets, no streaming.
 */
export class RCON {
  private socket: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private pending: Array<(resp: string) => void> = [];
  private nextId = 1;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly password: string,
    private readonly timeoutMs = 4000,
  ) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      const onError = (err: Error) => {
        sock.destroy();
        reject(err);
      };
      sock.once('error', onError);
      sock.once('connect', () => {
        sock.removeListener('error', onError);

        // Auth handshake.
        const authId = this.nextId++;
        this.sendPacket(sock, authId, 3 /* SERVERDATA_AUTH */, this.password);
        const authTimer = setTimeout(() => {
          sock.destroy();
          reject(new Error('RCON auth timed out.'));
        }, this.timeoutMs);

        const onAuthData = (chunk: Buffer) => {
          this.buffer = Buffer.concat([this.buffer, chunk]);
          const pkt = this.tryReadPacket();
          if (!pkt) return;
          if (pkt.id === authId && pkt.type === 2 /* SERVERDATA_AUTH_RESPONSE */) {
            // Auth response - empty body means success.
            clearTimeout(authTimer);
            sock.removeListener('data', onAuthData);
            this.socket = sock;
            sock.on('data', (c) => this.onData(c));
            sock.on('error', (e) => {
              logger.warn({ err: e }, 'RCON socket error.');
              this.socket = null;
            });
            sock.on('close', () => {
              this.socket = null;
              this.flushPendingOnClose();
            });
            resolve();
          }
        };
        sock.on('data', onAuthData);
      });
    });
  }

  disconnect(): void {
    try {
      this.socket?.end();
    } catch {
      /* ignore */
    }
    this.socket = null;
  }

  async send(command: string): Promise<string> {
    if (!this.socket) throw new Error('RCON not connected.');
    const id = this.nextId++;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove ourselves from the pending queue.
        const i = this.pending.findIndex((fn) => fn === responder);
        if (i >= 0) this.pending.splice(i, 1);
        reject(new Error(`RCON command timed out: ${command}`));
      }, this.timeoutMs);

      const responder = (resp: string) => {
        clearTimeout(timer);
        resolve(resp);
      };
      this.pending.push(responder);
      try {
        this.sendPacket(this.socket!, id, 2 /* SERVERDATA_EXECCOMMAND */, command);
      } catch (err) {
        clearTimeout(timer);
        const i = this.pending.findIndex((fn) => fn === responder);
        if (i >= 0) this.pending.splice(i, 1);
        reject(err);
      }
    });
  }

  private sendPacket(sock: net.Socket, id: number, type: number, body: string): void {
    const bodyBuf = Buffer.from(body, 'utf8');
    const len = 4 + 4 + bodyBuf.length + 2; // id + type + body + null terminators (2)
    const pkt = Buffer.allocUnsafe(4 + len);
    pkt.writeInt32LE(len, 0);
    pkt.writeInt32LE(id, 4);
    pkt.writeInt32LE(type, 8);
    bodyBuf.copy(pkt, 12);
    pkt.writeInt8(0, 12 + bodyBuf.length);
    pkt.writeInt8(0, 13 + bodyBuf.length);
    sock.write(pkt);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // Drain as many complete packets as we can.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const pkt = this.tryReadPacket();
      if (!pkt) break;
      const responder = this.pending.shift();
      if (responder) responder(pkt.body);
    }
  }

  private tryReadPacket(): { id: number; type: number; body: string } | null {
    if (this.buffer.length < 4) return null;
    const len = this.buffer.readInt32LE(0);
    if (this.buffer.length < 4 + len) return null;
    const id = this.buffer.readInt32LE(4);
    const type = this.buffer.readInt32LE(8);
    // Body is everything between type and the trailing two null bytes,
    // each of which is counted in `len` (4 id + 4 type + body + 2 nulls).
    const bodyBytes = this.buffer.subarray(12, 4 + len - 2);
    const body = bodyBytes.toString('utf8').replace(/\0+$/, '');
    this.buffer = this.buffer.subarray(4 + len);
    return { id, type, body };
  }

  private flushPendingOnClose(): void {
    while (this.pending.length > 0) {
      const responder = this.pending.shift();
      responder?.('');
    }
  }
}
