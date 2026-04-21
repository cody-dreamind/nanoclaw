import fs from 'fs';
import { IncomingMessage, ServerResponse } from 'http';
import {
  filterAuditEvents,
  listRawLogFiles,
  lookupRawFile,
  parseLimit,
  readAuditEvents,
  readTail,
} from './log-data.js';

const MAX_RAW_CHARS = 200_000;

function json(
  res: ServerResponse,
  status: number,
  payload: Record<string, unknown>,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function html(res: ServerResponse, body: string): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

function filterEventsFromQuery(
  query: URLSearchParams,
): ReturnType<typeof readAuditEvents> {
  const type = query.get('type')?.trim().toLowerCase();
  const q = query.get('q')?.trim().toLowerCase();
  const since = query.get('since')?.trim();
  const until = query.get('until')?.trim();
  return filterAuditEvents(readAuditEvents(), { type, q, since, until });
}

function renderPage(): string {
  return `<!doctype html>
<html lang="cs">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Cody Logs</title>
  <style>
    :root {
      --bg: #f5f2ea;
      --paper: #fffdf9;
      --ink: #1d1b19;
      --muted: #6a635c;
      --accent: #0057b8;
      --border: #d8d0c3;
      --code: #111827;
      --code-bg: #f3f4f6;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Georgia, "Iowan Old Style", serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, #efe6d5 0, transparent 35%),
        linear-gradient(180deg, #f7f1e6 0%, var(--bg) 100%);
    }
    header, main { max-width: 1280px; margin: 0 auto; padding: 24px; }
    header h1 { margin: 0 0 8px; font-size: 40px; }
    header p { margin: 0; color: var(--muted); }
    .layout {
      display: grid;
      grid-template-columns: 360px 1fr;
      gap: 20px;
      align-items: start;
    }
    .panel {
      background: var(--paper);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 18px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.05);
    }
    h2 { margin: 0 0 12px; font-size: 20px; }
    label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 6px; }
    input, select, button, textarea {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: white;
      font: inherit;
    }
    button {
      background: var(--accent);
      color: white;
      font-weight: 600;
      cursor: pointer;
    }
    .stack { display: grid; gap: 12px; }
    .events { display: grid; gap: 12px; }
    .event {
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 14px;
      background: white;
    }
    .meta {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 10px;
    }
    .badge {
      display: inline-block;
      background: #edf2ff;
      color: #1e3a8a;
      border-radius: 999px;
      padding: 2px 8px;
      font-weight: 600;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      color: var(--code);
      background: var(--code-bg);
      padding: 12px;
      border-radius: 12px;
      max-height: 420px;
      overflow: auto;
    }
    .raw-list { display: grid; gap: 8px; max-height: 280px; overflow: auto; }
    .raw-file {
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 10px;
      background: white;
      cursor: pointer;
    }
    .raw-file small { color: var(--muted); display: block; margin-top: 4px; }
    .raw-viewer { min-height: 320px; }
    @media (max-width: 980px) {
      .layout { grid-template-columns: 1fr; }
      header h1 { font-size: 30px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Cody Logs</h1>
    <p>Read-only audit and raw log viewer. Search actions, messages, emails, tasks, and container runs.</p>
  </header>
  <main class="layout">
    <section class="panel stack">
      <div>
        <h2>Filter</h2>
        <div class="stack">
          <div>
            <label for="q">Fulltext</label>
            <input id="q" placeholder="email, tweet, sendMail, codex..." />
          </div>
          <div>
            <label for="type">Event Type</label>
            <input id="type" placeholder="telegram_message_sent" />
          </div>
          <div>
            <label for="since">Since (ISO)</label>
            <input id="since" placeholder="2026-04-20T05:00:00Z" />
          </div>
          <div>
            <label for="until">Until (ISO)</label>
            <input id="until" placeholder="2026-04-20T06:00:00Z" />
          </div>
          <div>
            <label for="limit">Limit</label>
            <input id="limit" type="number" value="100" min="1" max="500" />
          </div>
          <button id="load">Load audit events</button>
        </div>
      </div>
      <div>
        <h2>Raw Logs</h2>
        <div id="raw-list" class="raw-list"></div>
      </div>
    </section>
    <section class="stack">
      <div class="panel">
        <h2>Audit Timeline</h2>
        <div id="events" class="events"></div>
      </div>
      <div class="panel">
        <h2>Raw Log Tail</h2>
        <div id="raw-meta" class="meta"></div>
        <pre id="raw-viewer" class="raw-viewer">Select a log file on the left.</pre>
      </div>
    </section>
  </main>
  <script>
    const qs = (id) => document.getElementById(id);

    function formatJson(value) {
      return JSON.stringify(value, null, 2);
    }

    async function loadEvents() {
      const params = new URLSearchParams({
        q: qs('q').value,
        type: qs('type').value,
        since: qs('since').value,
        until: qs('until').value,
        limit: qs('limit').value || '100',
      });
      const res = await fetch('/logs/api/events?' + params.toString());
      const data = await res.json();
      const eventsEl = qs('events');
      eventsEl.innerHTML = '';
      for (const event of data.events) {
        const wrap = document.createElement('article');
        wrap.className = 'event';
        wrap.innerHTML = \`
          <div class="meta">
            <span class="badge">\${event.type}</span>
            <span>\${event.ts}</span>
            <span>pid \${event.pid}</span>
          </div>
          <pre>\${formatJson(event.payload)}</pre>
        \`;
        eventsEl.appendChild(wrap);
      }
      if (!data.events.length) {
        eventsEl.innerHTML = '<p>No events matched the current filter.</p>';
      }
    }

    async function loadRawList() {
      const res = await fetch('/logs/api/raw-files');
      const data = await res.json();
      const list = qs('raw-list');
      list.innerHTML = '';
      for (const file of data.files) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'raw-file';
        item.innerHTML = '<strong>' + file.label + '</strong><small>' + file.mtime + ' • ' + file.size + ' bytes</small>';
        item.onclick = () => loadRawFile(file.key, file.label, file.mtime, file.size);
        list.appendChild(item);
      }
    }

    async function loadRawFile(key, label, mtime, size) {
      const res = await fetch('/logs/api/raw-file?key=' + encodeURIComponent(key));
      const data = await res.json();
      qs('raw-meta').innerHTML = '<span class="badge">' + label + '</span><span>' + mtime + '</span><span>' + size + ' bytes</span>';
      qs('raw-viewer').textContent = data.content;
    }

    qs('load').onclick = loadEvents;
    loadEvents();
    loadRawList();
  </script>
</body>
</html>`;
}

export function handleLogsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): boolean {
  if (!url.pathname.startsWith('/logs')) return false;

  if (url.pathname === '/logs' || url.pathname === '/logs/') {
    html(res, renderPage());
    return true;
  }

  if (url.pathname === '/logs/api/events') {
    const limit = parseLimit(url.searchParams.get('limit'), 100, 500);
    const events = filterEventsFromQuery(url.searchParams).slice(0, limit);
    json(res, 200, { events });
    return true;
  }

  if (url.pathname === '/logs/api/raw-files') {
    json(res, 200, { files: listRawLogFiles().slice(0, 200) });
    return true;
  }

  if (url.pathname === '/logs/api/raw-file') {
    const key = url.searchParams.get('key');
    if (!key) {
      json(res, 400, { error: 'Missing key' });
      return true;
    }

    const fullPath = lookupRawFile(key);
    if (!fullPath) {
      json(res, 404, { error: 'File not found' });
      return true;
    }

    json(res, 200, { key, content: readTail(fullPath, MAX_RAW_CHARS) });
    return true;
  }

  json(res, 404, { error: 'Not found' });
  return true;
}
