import { WhatsAppClient, GroupEntry } from './whatsapp';
import { logger } from './logger';
import { AppConfig } from './config';

/**
 * One-shot mode: list every WhatsApp group the connected account is a
 * member of and exit.  Used to discover the JID for a new deployment.
 *
 * The output is written to BOTH structured logs (for `docker compose
 * logs`) and to a plain-text table on stdout (so an operator can
 * `docker compose run --rm minewatch` and grab the JID with a simple
 * `grep JID`).
 */
export async function runListGroupsMode(client: WhatsAppClient): Promise<void> {
  logger.info('LIST_GROUPS_ON_START enabled - enumerating groups and exiting.');

  await client.waitForOpen();
  const groups = await client.listGroups();

  if (groups.length === 0) {
    logger.warn('No groups found for this WhatsApp account.');
  } else {
    logger.info({ count: groups.length }, `Found ${groups.length} group(s).`);
  }

  // Pretty table for human eyes + the machine-parseable JID-only line
  // for easy grep / piping.
  printGroupsTable(groups);

  logger.info(
    'Copy the JID of your target group into WHATSAPP_GROUP_JID in your .env, then unset LIST_GROUPS_ON_START and restart the daemon.',
  );
  process.exit(0);
}

/**
 * One-shot mode: pick the first group whose subject contains the
 * configured keyword (case-insensitive), print its JID, and exit.
 * Useful in CI / auto-deploy scripts.
 */
export async function runPickGroupMode(client: WhatsAppClient, cfg: AppConfig): Promise<void> {
  const keyword = cfg.groupMatchKeyword!;
  logger.info(
    { keyword },
    'GROUP_MATCH_KEYWORD enabled - looking for a group whose subject contains this keyword.',
  );

  await client.waitForOpen();
  const groups = await client.listGroups();
  const needle = keyword.toLowerCase();
  const match = groups.find((g) => g.subject.toLowerCase().includes(needle));

  if (!match) {
    logger.error(
      { keyword, available: groups.map((g) => g.subject) },
      'No group matched the keyword.',
    );
    process.exit(2);
  }

  logger.info(
    { jid: match.jid, subject: match.subject, participants: match.participants },
    'Matched group. Set this as WHATSAPP_GROUP_JID:',
  );
  // Also print a copy-paste-ready line on stdout.
  process.stdout.write(`\nWHATSAPP_GROUP_JID=${match.jid}\n\n`);
  process.exit(0);
}

function printGroupsTable(groups: GroupEntry[]): void {
  if (groups.length === 0) return;
  const subjWidth = Math.max(8, ...groups.map((g) => g.subject.length));
  const jidWidth = Math.max(3, ...groups.map((g) => g.jid.length));
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));
  const sep = '-'.repeat(subjWidth + jidWidth + 18);

  process.stdout.write('\n');
  process.stdout.write(`${pad('SUBJECT', subjWidth)}  ${pad('JID', jidWidth)}  PARTICIPANTS\n`);
  process.stdout.write(`${sep}\n`);
  for (const g of groups) {
    process.stdout.write(
      `${pad(g.subject, subjWidth)}  ${pad(g.jid, jidWidth)}  ${g.participants}\n`,
    );
  }
  process.stdout.write(`\nTotal: ${groups.length} group(s)\n\n`);
}
