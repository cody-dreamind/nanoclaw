import fs from 'fs';
import path from 'path';

const PROJECT_ROOT = process.cwd();
const LOGS_DIR = path.join(PROJECT_ROOT, 'logs');
const AUDIT_DIR = path.join(LOGS_DIR, 'audit');
const GROUPS_DIR = path.join(PROJECT_ROOT, 'groups');

export interface AuditEvent {
  ts: string;
  pid: number;
  type: string;
  payload: Record<string, unknown>;
}

export interface RawLogFile {
  key: string;
  label: string;
  path: string;
  size: number;
  mtime: string;
}

export function parseLimit(
  input: string | null,
  fallback: number,
  max: number,
): number {
  const value = parseInt(input || '', 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(value, max);
}

export function readAuditEvents(): AuditEvent[] {
  if (!fs.existsSync(AUDIT_DIR)) return [];

  const files = fs
    .readdirSync(AUDIT_DIR)
    .filter((file) => file.endsWith('.jsonl'))
    .sort()
    .reverse();

  const events: AuditEvent[] = [];
  for (const file of files) {
    const fullPath = path.join(AUDIT_DIR, file);
    const content = fs.readFileSync(fullPath, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as AuditEvent);
      } catch {
        // Keep readers resilient to malformed lines.
      }
    }
  }

  return events.sort((a, b) => b.ts.localeCompare(a.ts));
}

export function filterAuditEvents(
  events: AuditEvent[],
  query: {
    type?: string | null;
    q?: string | null;
    since?: string | null;
    until?: string | null;
    groupFolder?: string | null;
    chatJid?: string | null;
    containerName?: string | null;
  },
): AuditEvent[] {
  const type = query.type?.trim().toLowerCase();
  const q = query.q?.trim().toLowerCase();
  const since = query.since?.trim();
  const until = query.until?.trim();
  const groupFolder = query.groupFolder?.trim();
  const chatJid = query.chatJid?.trim();
  const containerName = query.containerName?.trim();

  return events.filter((event) => {
    if (type && event.type.toLowerCase() !== type) return false;
    if (since && event.ts < since) return false;
    if (until && event.ts > until) return false;

    const payload = event.payload || {};
    if (groupFolder && payload.groupFolder !== groupFolder) return false;
    if (chatJid && payload.chatJid !== chatJid && payload.groupJid !== chatJid)
      return false;
    if (containerName && payload.containerName !== containerName) return false;

    if (q) {
      const haystack = JSON.stringify(event).toLowerCase();
      if (!haystack.includes(q)) return false;
    }

    return true;
  });
}

export function listRawLogFiles(): RawLogFile[] {
  const files: RawLogFile[] = [];

  if (fs.existsSync(LOGS_DIR)) {
    for (const entry of fs.readdirSync(LOGS_DIR)) {
      const fullPath = path.join(LOGS_DIR, entry);
      if (!fs.statSync(fullPath).isFile()) continue;
      const stat = fs.statSync(fullPath);
      files.push({
        key: `root:${entry}`,
        label: `logs/${entry}`,
        path: fullPath,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      });
    }
  }

  if (fs.existsSync(GROUPS_DIR)) {
    for (const group of fs.readdirSync(GROUPS_DIR)) {
      const groupLogsDir = path.join(GROUPS_DIR, group, 'logs');
      if (!fs.existsSync(groupLogsDir)) continue;
      for (const entry of fs.readdirSync(groupLogsDir).sort().reverse()) {
        const fullPath = path.join(groupLogsDir, entry);
        if (!fs.statSync(fullPath).isFile()) continue;
        const stat = fs.statSync(fullPath);
        files.push({
          key: `group:${group}:${entry}`,
          label: `groups/${group}/logs/${entry}`,
          path: fullPath,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
        });
      }
    }
  }

  return files.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

export function lookupRawFile(key: string): string | null {
  return listRawLogFiles().find((file) => file.key === key)?.path || null;
}

export function readTail(fullPath: string, maxChars: number): string {
  const content = fs.readFileSync(fullPath, 'utf-8');
  return content.length > maxChars
    ? `...[truncated]\n${content.slice(-maxChars)}`
    : content;
}
