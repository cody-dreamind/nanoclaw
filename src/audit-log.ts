import fs from 'fs';
import path from 'path';

const AUDIT_DIR = path.join(process.cwd(), 'logs', 'audit');
const MAX_STRING = 20_000;

function ensureAuditDir(): void {
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
}

function currentAuditFile(): string {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(AUDIT_DIR, `${day}.jsonl`);
}

function truncate(value: string): string {
  return value.length > MAX_STRING
    ? `${value.slice(0, MAX_STRING)}\n...[truncated ${value.length - MAX_STRING} chars]`
    : value;
}

function redactString(value: string): string {
  let out = truncate(value);

  out = out.replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]');
  out = out.replace(
    /\b(access_token|refresh_token|client_secret|api[_-]?key|authorization)\b["'=:\s]+([^\s",'`]+)/gi,
    '$1=[REDACTED]',
  );
  out = out.replace(
    /\b(ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9]+)/g,
    '[REDACTED]',
  );

  return out;
}

function sanitize(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (
        /(token|secret|authorization|cookie|password|api[_-]?key)/i.test(key)
      ) {
        out[key] = '[REDACTED]';
      } else {
        out[key] = sanitize(inner);
      }
    }
    return out;
  }
  return value;
}

export function writeAuditEvent(
  type: string,
  payload: Record<string, unknown>,
): void {
  ensureAuditDir();
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    pid: process.pid,
    type,
    payload: sanitize(payload),
  });
  fs.appendFileSync(currentAuditFile(), `${line}\n`);
}
