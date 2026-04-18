/**
 * Microsoft Graph webhook receiver.
 * Listens for email change notifications and injects them as messages for Cody.
 */
import http from 'http';
import https from 'https';
import fs from 'fs';
import crypto from 'crypto';

import { logger } from './logger.js';
import { storeMessage } from './db.js';
import {
  MS_CLIENT_ID,
  MS_CLIENT_SECRET,
  MS_REFRESH_TOKEN,
  MS_TENANT_ID,
  WEBHOOK_PORT,
  WEBHOOK_URL,
  WEBHOOK_CERT_PATH,
  WEBHOOK_KEY_PATH,
  WEBHOOK_CLIENT_STATE,
} from './config.js';
import { NewMessage } from './types.js';

const CERT_PATH = WEBHOOK_CERT_PATH;
const KEY_PATH = WEBHOOK_KEY_PATH;
const CLIENT_STATE = WEBHOOK_CLIENT_STATE;

// Subscription expiry — Graph allows max 4230 min for mail; renew at 80%
const SUBSCRIPTION_TTL_MS = 4230 * 60 * 1000;
const RENEW_AT_MS = SUBSCRIPTION_TTL_MS * 0.8;

let subscriptionId: string | null = null;
let subscriptionExpiry: number = 0;
let accessToken: string | null = null;
let accessTokenExpiry: number = 0;
let mainGroupJid: string | null = null;

type OnEmailNotification = (message: NewMessage) => void;
let onEmailNotification: OnEmailNotification | null = null;

async function getAccessToken(): Promise<string> {
  if (accessToken && Date.now() < accessTokenExpiry - 60_000) return accessToken;

  const res = await fetch(
    `https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: MS_CLIENT_ID!,
        client_secret: MS_CLIENT_SECRET!,
        refresh_token: MS_REFRESH_TOKEN!,
        scope: 'Mail.Read Mail.ReadWrite offline_access',
      }),
    },
  );
  const data = (await res.json()) as { access_token: string; expires_in: number };
  if (!data.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  accessToken = data.access_token;
  accessTokenExpiry = Date.now() + data.expires_in * 1000;
  return accessToken;
}

async function fetchEmailDetails(messageId: string): Promise<{ subject: string; from: string; preview: string } | null> {
  try {
    const token = await getAccessToken();
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/me/messages/${messageId}?$select=subject,from,bodyPreview`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const data = (await res.json()) as { subject?: string; from?: { emailAddress?: { address?: string } }; bodyPreview?: string };
    return {
      subject: data.subject || '(bez předmětu)',
      from: data.from?.emailAddress?.address || 'neznámý odesílatel',
      preview: data.bodyPreview || '',
    };
  } catch {
    return null;
  }
}

async function registerSubscription(): Promise<void> {
  if (!MS_CLIENT_ID || !MS_TENANT_ID || !MS_CLIENT_SECRET || !MS_REFRESH_TOKEN) {
    logger.warn('MS credentials missing — Graph webhook disabled');
    return;
  }

  try {
    const token = await getAccessToken();
    const expiry = new Date(Date.now() + SUBSCRIPTION_TTL_MS).toISOString();

    const body: Record<string, string> = {
      changeType: 'created',
      notificationUrl: WEBHOOK_URL,
      resource: 'me/mailFolders/inbox/messages',
      expirationDateTime: expiry,
      clientState: CLIENT_STATE,
    };

    let res: Response;
    if (subscriptionId) {
      // Renew existing
      res = await fetch(`https://graph.microsoft.com/v1.0/subscriptions/${subscriptionId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expirationDateTime: expiry }),
      });
    } else {
      // Create new
      res = await fetch('https://graph.microsoft.com/v1.0/subscriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    const data = (await res.json()) as { id?: string; expirationDateTime?: string; error?: unknown };
    if (data.id) {
      subscriptionId = data.id;
      subscriptionExpiry = new Date(data.expirationDateTime!).getTime();
      logger.info({ subscriptionId, expiry: data.expirationDateTime }, 'Graph subscription active');
    } else {
      logger.error({ data }, 'Graph subscription failed');
      subscriptionId = null;
    }
  } catch (err) {
    logger.error({ err }, 'Graph subscription error');
  }

  // Schedule renewal
  const renewIn = subscriptionId ? RENEW_AT_MS : 60_000;
  setTimeout(() => registerSubscription(), renewIn);
}

function handleNotification(body: string, res: http.ServerResponse): void {
  res.writeHead(202);
  res.end();

  let payload: { value?: Array<{ clientState?: string; resourceData?: { id?: string }; resource?: string }> };
  try {
    payload = JSON.parse(body);
  } catch {
    return;
  }

  for (const notification of payload.value ?? []) {
    if (notification.clientState !== CLIENT_STATE) continue;

    const messageId = notification.resourceData?.id;
    if (!messageId || !mainGroupJid) continue;

    // Fetch email details async and inject as a message
    fetchEmailDetails(messageId).then((email) => {
      const content = email
        ? `[Nový email] Od: ${email.from}\nPředmět: ${email.subject}\n${email.preview}`
        : `[Nový email] ID: ${messageId}`;

      const msg: NewMessage = {
        id: `graph-${crypto.randomUUID()}`,
        chat_jid: mainGroupJid!,
        sender: 'email-notification',
        sender_name: 'Email',
        content,
        timestamp: new Date().toISOString(),
        is_from_me: false,
        is_bot_message: false,
      };

      logger.info({ from: email?.from, subject: email?.subject }, 'Graph email notification received');
      if (onEmailNotification) {
        onEmailNotification(msg);
      } else {
        storeMessage(msg);
      }
    });
  }
}

export function startWebhookServer(opts: {
  groupJid: string;
  onMessage?: OnEmailNotification;
}): void {
  mainGroupJid = opts.groupJid;
  onEmailNotification = opts.onMessage ?? null;

  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url || '/', `http://localhost`);

    if (url.pathname !== '/webhook/graph') {
      res.writeHead(404);
      res.end();
      return;
    }

    // Graph validation handshake — Microsoft sends POST with ?validationToken=xxx
    const validationToken = url.searchParams.get('validationToken');
    if (validationToken) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(validationToken);
      return;
    }

    // Incoming notification
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => handleNotification(body, res));
      return;
    }

    res.writeHead(405);
    res.end();
  };

  let server: http.Server | https.Server;
  if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
    server = https.createServer(
      { cert: fs.readFileSync(CERT_PATH), key: fs.readFileSync(KEY_PATH) },
      handler,
    );
  } else {
    logger.warn('TLS cert not found — falling back to HTTP');
    server = http.createServer(handler);
  }

  server.listen(WEBHOOK_PORT, () => {
    logger.info({ port: WEBHOOK_PORT }, 'Graph webhook server listening');
  });

  // Register subscription after server is up
  setTimeout(() => registerSubscription(), 2000);
}
