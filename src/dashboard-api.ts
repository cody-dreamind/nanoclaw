import { IncomingMessage, ServerResponse } from 'http';

import {
  getDueTasks,
  getMessages,
  getTaskRunLogs,
  MessageRecord,
} from './db.js';
import { DASHBOARD_API_TOKEN } from './config.js';
import { GroupQueueSnapshot } from './group-queue.js';
import {
  AuditEvent,
  filterAuditEvents,
  listRawLogFiles,
  lookupRawFile,
  parseLimit,
  readAuditEvents,
  readTail,
} from './log-data.js';
import { RegisteredGroup } from './types.js';

const MAX_RAW_CHARS = 200_000;
const RUN_TASK_MATCH_WINDOW_MS = 15_000;

interface DashboardRun {
  id: string;
  kind: 'scheduled_task' | 'conversation';
  groupFolder: string | null;
  chatJid: string | null;
  containerName: string | null;
  startedAt: string;
  endedAt: string | null;
  status: 'running' | 'success' | 'error';
  provider: 'claude' | 'codex' | 'unknown';
  summary: string | null;
  error: string | null;
  taskId: string | null;
  relatedEventCount: number;
  promptPreview: string | null;
}

export interface DashboardApiDeps {
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  getQueueSnapshot: () => GroupQueueSnapshot;
  enqueuePrompt: (
    text: string,
    actor: string | null,
  ) => { messageId: string; chatJid: string; groupFolder: string };
}

function json(
  res: ServerResponse,
  status: number,
  payload: Record<string, unknown>,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function unauthorized(res: ServerResponse): void {
  json(res, 401, { error: 'Unauthorized' });
}

function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    unauthorized(res);
    return false;
  }
  const token = auth.slice('Bearer '.length).trim();
  if (!token || token !== DASHBOARD_API_TOKEN) {
    unauthorized(res);
    return false;
  }
  return true;
}

function preview(text: string | null | undefined, max = 240): string | null {
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function getPayloadValue(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === 'string' ? value : null;
}

function setSummary(run: DashboardRun, summary: string | null): void {
  if (!summary || run.summary) return;
  run.summary = preview(summary, 400);
}

function normalizeMessageRecord(
  message: MessageRecord,
): Record<string, unknown> {
  return {
    ...message,
    is_from_me: Boolean(message.is_from_me),
    is_bot_message: Boolean(message.is_bot_message),
  };
}

function buildRuns(events: AuditEvent[]): DashboardRun[] {
  const runs = new Map<string, DashboardRun>();
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts));
  const taskStartByGroup = new Map<
    string,
    { taskId: string; ts: string; prompt: string | null }
  >();

  const ensureRun = (
    containerName: string,
    defaults: Partial<DashboardRun> = {},
  ): DashboardRun => {
    let run = runs.get(containerName);
    if (!run) {
      run = {
        id: containerName,
        kind: defaults.kind || 'conversation',
        groupFolder: defaults.groupFolder || null,
        chatJid: defaults.chatJid || null,
        containerName,
        startedAt: defaults.startedAt || new Date(0).toISOString(),
        endedAt: defaults.endedAt || null,
        status: defaults.status || 'running',
        provider: defaults.provider || 'unknown',
        summary: defaults.summary || null,
        error: defaults.error || null,
        taskId: defaults.taskId || null,
        relatedEventCount: 0,
        promptPreview: defaults.promptPreview || null,
      };
      runs.set(containerName, run);
    }
    return run;
  };

  for (const event of sorted) {
    const payload = event.payload || {};
    const groupFolder = getPayloadValue(payload, 'groupFolder');
    const chatJid =
      getPayloadValue(payload, 'chatJid') ||
      getPayloadValue(payload, 'groupJid');
    const containerName = getPayloadValue(payload, 'containerName');

    if (event.type === 'task_run_start') {
      const taskId = getPayloadValue(payload, 'taskId');
      if (taskId && groupFolder && chatJid) {
        taskStartByGroup.set(`${groupFolder}:${chatJid}`, {
          taskId,
          ts: event.ts,
          prompt: preview(getPayloadValue(payload, 'prompt')),
        });
      }
    }

    if (event.type === 'container_spawn' && containerName) {
      const isScheduledTask = payload.isScheduledTask === true;
      const run = ensureRun(containerName, {
        kind: isScheduledTask ? 'scheduled_task' : 'conversation',
        groupFolder,
        chatJid,
        startedAt: event.ts,
        status: 'running',
        promptPreview: preview(getPayloadValue(payload, 'prompt')),
      });
      run.relatedEventCount++;

      if (isScheduledTask && groupFolder && chatJid) {
        const candidate = taskStartByGroup.get(`${groupFolder}:${chatJid}`);
        if (candidate) {
          const delta = Math.abs(
            new Date(event.ts).getTime() - new Date(candidate.ts).getTime(),
          );
          if (delta <= RUN_TASK_MATCH_WINDOW_MS) {
            run.taskId = candidate.taskId;
            if (!run.promptPreview) run.promptPreview = candidate.prompt;
          }
        }
      }
      continue;
    }

    if (!containerName) continue;

    const run = ensureRun(containerName, {
      groupFolder,
      chatJid,
      startedAt: event.ts,
    });
    run.relatedEventCount++;
    if (!run.groupFolder && groupFolder) run.groupFolder = groupFolder;
    if (!run.chatJid && chatJid) run.chatJid = chatJid;

    if (event.type === 'agent_runner_event') {
      const subtype = getPayloadValue(payload, 'type');
      const innerPayload =
        payload.payload && typeof payload.payload === 'object'
          ? (payload.payload as Record<string, unknown>)
          : {};

      if (subtype === 'claude_query_start' && run.provider === 'unknown') {
        run.provider = 'claude';
      }
      if (subtype === 'provider_selection') {
        const provider = getPayloadValue(innerPayload, 'provider');
        if (provider === 'codex' || provider === 'claude') {
          run.provider = provider;
        }
      }
      if (subtype === 'codex_result') {
        run.provider = 'codex';
        setSummary(run, getPayloadValue(innerPayload, 'result'));
      }
      if (subtype === 'claude_result') {
        if (run.provider === 'unknown') run.provider = 'claude';
        setSummary(run, getPayloadValue(innerPayload, 'result'));
      }
    }

    if (event.type === 'container_exit') {
      run.endedAt = event.ts;
      run.status = payload.status === 'error' ? 'error' : 'success';
      setSummary(run, getPayloadValue(payload, 'result'));
    } else if (event.type === 'container_timeout') {
      run.endedAt = event.ts;
      run.status = 'error';
      run.error = `Container timeout after ${payload.duration || 'unknown'}ms`;
    } else if (event.type === 'agent_run_end') {
      run.endedAt = event.ts;
      const status = getPayloadValue(payload, 'status');
      if (status === 'error') run.status = 'error';
      if (status === 'success' && run.status === 'running')
        run.status = 'success';
      run.error = getPayloadValue(payload, 'error') || run.error;
    }
  }

  for (const event of sorted) {
    if (event.type !== 'task_run_end') continue;
    const payload = event.payload || {};
    const taskId = getPayloadValue(payload, 'taskId');
    if (!taskId) continue;
    for (const run of runs.values()) {
      if (run.taskId !== taskId) continue;
      if (!run.endedAt) run.endedAt = event.ts;
      if (payload.status === 'error') run.status = 'error';
      if (payload.status === 'success' && run.status === 'running') {
        run.status = 'success';
      }
      setSummary(run, getPayloadValue(payload, 'result'));
      run.error = getPayloadValue(payload, 'error') || run.error;
    }
  }

  return [...runs.values()].sort((a, b) =>
    b.startedAt.localeCompare(a.startedAt),
  );
}

function lastServiceStart(events: AuditEvent[]): AuditEvent | undefined {
  return events.find((event) => event.type === 'service_start');
}

export async function handleDashboardApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: DashboardApiDeps,
): Promise<boolean> {
  if (!url.pathname.startsWith('/dashboard-api/v1')) return false;
  if (!requireAuth(req, res)) return true;

  const events = readAuditEvents();

  if (url.pathname === '/dashboard-api/v1/health') {
    const snapshot = deps.getQueueSnapshot();
    const serviceStart = lastServiceStart(events);
    json(res, 200, {
      service: 'nanoclaw',
      status: 'ok',
      lastServiceStart: serviceStart?.ts || null,
      activeContainerCount: snapshot.activeCount,
      pendingMessageGroups: snapshot.groups.filter(
        (group) => group.pendingMessages,
      ).length,
      pendingTaskCount: snapshot.groups.reduce(
        (sum, group) => sum + group.pendingTaskCount,
        0,
      ),
      dueTaskCount: getDueTasks().length,
      activeGroups: snapshot.groups.filter((group) => group.active),
    });
    return true;
  }

  if (url.pathname === '/dashboard-api/v1/groups') {
    const groups = Object.entries(deps.getRegisteredGroups()).map(
      ([jid, group]) => ({
        jid,
        ...group,
      }),
    );
    json(res, 200, { groups });
    return true;
  }

  if (url.pathname === '/dashboard-api/v1/events') {
    const limit = parseLimit(url.searchParams.get('limit'), 100, 500);
    const filtered = filterAuditEvents(events, {
      type: url.searchParams.get('type'),
      q: url.searchParams.get('q'),
      since: url.searchParams.get('since'),
      until: url.searchParams.get('until'),
      groupFolder: url.searchParams.get('groupFolder'),
      chatJid: url.searchParams.get('chatJid'),
      containerName: url.searchParams.get('containerName'),
    }).slice(0, limit);
    json(res, 200, { events: filtered });
    return true;
  }

  if (url.pathname === '/dashboard-api/v1/runs') {
    const limit = parseLimit(url.searchParams.get('limit'), 50, 200);
    const filteredEvents = filterAuditEvents(events, {
      q: url.searchParams.get('q'),
      since: url.searchParams.get('since'),
      until: url.searchParams.get('until'),
      groupFolder: url.searchParams.get('groupFolder'),
      chatJid: url.searchParams.get('chatJid'),
    });
    const runs = buildRuns(filteredEvents).slice(0, limit);
    json(res, 200, { runs });
    return true;
  }

  if (
    url.pathname.startsWith('/dashboard-api/v1/runs/') &&
    req.method === 'GET'
  ) {
    const runId = decodeURIComponent(
      url.pathname.slice('/dashboard-api/v1/runs/'.length),
    );
    const runs = buildRuns(events);
    const run = runs.find((item) => item.id === runId);
    if (!run) {
      json(res, 404, { error: 'Run not found' });
      return true;
    }

    const relatedEvents = filterAuditEvents(events, {
      containerName: run.containerName,
    });
    const taskLogs = run.taskId
      ? getTaskRunLogs({ taskId: run.taskId, limit: 50 })
      : [];

    json(res, 200, {
      run,
      events: relatedEvents,
      taskRuns: taskLogs,
    });
    return true;
  }

  if (url.pathname === '/dashboard-api/v1/messages') {
    const limit = parseLimit(url.searchParams.get('limit'), 100, 500);
    const messages = getMessages({
      chatJid: url.searchParams.get('chatJid') || undefined,
      sender: url.searchParams.get('sender') || undefined,
      since: url.searchParams.get('since') || undefined,
      until: url.searchParams.get('until') || undefined,
      limit,
    }).map(normalizeMessageRecord);
    json(res, 200, { messages });
    return true;
  }

  if (url.pathname === '/dashboard-api/v1/task-runs') {
    const limit = parseLimit(url.searchParams.get('limit'), 100, 500);
    const taskRuns = getTaskRunLogs({
      taskId: url.searchParams.get('taskId') || undefined,
      groupFolder: url.searchParams.get('groupFolder') || undefined,
      chatJid: url.searchParams.get('chatJid') || undefined,
      since: url.searchParams.get('since') || undefined,
      until: url.searchParams.get('until') || undefined,
      limit,
    });
    json(res, 200, { taskRuns });
    return true;
  }

  if (url.pathname === '/dashboard-api/v1/raw-files') {
    json(res, 200, { files: listRawLogFiles().slice(0, 200) });
    return true;
  }

  if (url.pathname.startsWith('/dashboard-api/v1/raw-files/')) {
    const key = decodeURIComponent(
      url.pathname.slice('/dashboard-api/v1/raw-files/'.length),
    );
    const fullPath = lookupRawFile(key);
    if (!fullPath) {
      json(res, 404, { error: 'File not found' });
      return true;
    }
    json(res, 200, { key, content: readTail(fullPath, MAX_RAW_CHARS) });
    return true;
  }

  if (url.pathname === '/dashboard-api/v1/prompts' && req.method === 'POST') {
    try {
      const raw = await parseBody(req);
      const data = JSON.parse(raw) as { text?: string };
      const text = data.text?.trim();
      if (!text) {
        json(res, 400, { error: 'Missing text' });
        return true;
      }
      const actorHeader = req.headers['x-dashboard-actor'];
      const actor =
        typeof actorHeader === 'string'
          ? actorHeader
          : Array.isArray(actorHeader)
            ? actorHeader[0] || null
            : null;
      const queued = deps.enqueuePrompt(text, actor);
      json(res, 201, { queued });
    } catch (err) {
      json(res, 400, {
        error: err instanceof Error ? err.message : 'Invalid request body',
      });
    }
    return true;
  }

  json(res, 404, { error: 'Not found' });
  return true;
}
