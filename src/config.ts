import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config();

function req(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v.trim();
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) {
    throw new Error(`Environment variable ${name} must be a number, got: ${v}`);
  }
  return n;
}

function float(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseFloat(v);
  if (Number.isNaN(n)) {
    throw new Error(`Environment variable ${name} must be a number, got: ${v}`);
  }
  return n;
}

function opt(name: string): string | undefined {
  const v = process.env[name];
  if (!v || v.trim() === '') return undefined;
  return v.trim();
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (!v) return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

export type AppMode = 'daemon' | 'list-groups' | 'pick-group';

export interface AppConfig {
  mode: AppMode;
  whatsapp: {
    /** Required in 'daemon' and 'pick-group' modes; optional in 'list-groups'. */
    groupJid?: string;
    authDir: string;
  };
  minecraft: {
    host: string;
    port: number;
    rconPort?: number;
    rconPassword?: string;
    logPath?: string;
  };
  thresholds: {
    pollIntervalMs: number;
    latencyIntervalMs: number;
    pingThresholdMs: number;
    downFailCount: number;
    highPingFailCount: number;
    tpsThreshold: number;
  };
  logLevel: string;
  /** Only used in 'pick-group' mode. Substring (case-insensitive) match against group subject. */
  groupMatchKeyword?: string;
}

/**
 * Detect run mode from environment variables:
 *   LIST_GROUPS_ON_START=true   -> 'list-groups' (one-shot, print all groups, exit)
 *   GROUP_MATCH_KEYWORD=foo     -> 'pick-group' (find the first group whose
 *                                  subject contains "foo", print its JID, exit)
 *   default                      -> 'daemon' (normal monitoring)
 */
function detectMode(): AppMode {
  if (bool('LIST_GROUPS_ON_START', false)) return 'list-groups';
  if (opt('GROUP_MATCH_KEYWORD')) return 'pick-group';
  return 'daemon';
}

export function loadConfig(): AppConfig {
  const mode = detectMode();
  return {
    mode,
    whatsapp: {
      // In list-groups and pick-group modes the user does not yet know
      // the JID; do not require it.  In daemon mode it is mandatory.
      groupJid:
        mode === 'list-groups' || mode === 'pick-group'
          ? opt('WHATSAPP_GROUP_JID')
          : req('WHATSAPP_GROUP_JID'),
      authDir: path.resolve(process.cwd(), opt('WHATSAPP_AUTH_DIR') ?? './auth_info'),
    },
    minecraft: {
      host: req('MC_HOST'),
      port: num('MC_PORT', 25565),
      rconPort: opt('MC_RCON_PORT') ? num('MC_RCON_PORT', 25575) : undefined,
      rconPassword: opt('MC_RCON_PASSWORD'),
      logPath: opt('MC_LOG_PATH') ? path.resolve(opt('MC_LOG_PATH')!) : undefined,
    },
    thresholds: {
      pollIntervalMs: num('POLL_INTERVAL_MS', 5000),
      latencyIntervalMs: num('LATENCY_INTERVAL_MS', 10000),
      pingThresholdMs: num('PING_THRESHOLD_MS', 150),
      downFailCount: num('DOWN_FAIL_COUNT', 3),
      highPingFailCount: num('HIGH_PING_FAIL_COUNT', 3),
      tpsThreshold: float('TPS_THRESHOLD', 18.0),
    },
    logLevel: opt('LOG_LEVEL') ?? 'info',
    groupMatchKeyword: opt('GROUP_MATCH_KEYWORD'),
  };
}
