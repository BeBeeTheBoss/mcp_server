import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

config({ path: fileURLToPath(new URL('.env', import.meta.url)), quiet: true });

const baseUrl = process.env.API_BASE_URL;
if (!baseUrl) {
  console.error('Set API_BASE_URL to the Laravel /api URL.');
  process.exit(1);
}

const apiBase = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
if (!['http:', 'https:'].includes(apiBase.protocol)) {
  throw new Error('API_BASE_URL must use http or https.');
}

const port = Number(process.env.PORT || 8000);
const host = process.env.HOST || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

const mcpPublicUrl = new URL(
  process.env.MCP_PUBLIC_URL || `http://localhost:${port}/mcp`,
);
const authorizationServerUrl = new URL(
  process.env.AUTHORIZATION_SERVER_URL || apiBase.origin,
);
const resourceMetadataUrl = new URL(
  '/.well-known/oauth-protected-resource',
  mcpPublicUrl,
);

async function apiRequest(path, { method = 'GET', query, body, token } = {}) {
  const url = new URL(path.replace(/^\/+/, ''), apiBase);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });

  if (!response.ok) {
    const error = new Error(`API request failed (HTTP ${response.status}).`);
    error.status = response.status;
    throw error;
  }

  const text = await response.text();
  if (!text) return { success: true };
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function verifyAccessToken(token) {
  const profile = await apiRequest('oauth/user', { token });
  return {
    token,
    clientId: profile.client_id || 'chatgpt',
    scopes: Array.isArray(profile.scopes) ? profile.scopes : [],
    expiresAt: profile.expires_at || undefined,
    extra: {
      userId: profile.id,
      employeeId: profile.employee_id,
      name: profile.name,
    },
  };
}

function oauthError(scopes) {
  const scope = scopes.join(' ');
  const challenge = [
    `Bearer resource_metadata="${resourceMetadataUrl}"`,
    `scope="${scope}"`,
    'error="insufficient_scope"',
    'error_description="Connect your Meeting Room account to continue"',
  ].join(', ');

  return {
    isError: true,
    content: [{ type: 'text', text: 'Authentication is required for this action.' }],
    _meta: { 'mcp/www_authenticate': [challenge] },
  };
}

function authenticated(extra, scopes) {
  const auth = extra?.authInfo;
  if (!auth || !scopes.every((scope) => auth.scopes.includes(scope))) {
    return null;
  }
  return auth;
}

async function toolResult(request) {
  try {
    const result = await request();
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result && typeof result === 'object' ? result : undefined,
    };
  } catch (error) {
    const message = error.name === 'TimeoutError'
      ? 'The meeting-room API timed out.'
      : error.message.startsWith('API request failed')
        ? error.message
        : 'Unable to reach the meeting-room API.';
    return { isError: true, content: [{ type: 'text', text: message }] };
  }
}

const readSecurity = [{ type: 'oauth2', scopes: ['meeting:read'] }];
const writeSecurity = [{ type: 'oauth2', scopes: ['meeting:write'] }];
const noAuthSecurity = [{ type: 'noauth' }];

function createMcpServer() {
  const server = new McpServer({
    name: 'meeting-room-booking',
    version: '1.0.0',
  });

  server.registerTool('list_meeting_rooms', {
    title: 'List meeting rooms',
    description: 'List meeting rooms, capacity, branch, status, and room image.',
    inputSchema: {},
    securitySchemes: noAuthSecurity,
    _meta: { securitySchemes: noAuthSecurity },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => toolResult(() => apiRequest('meeting-rooms')));

  server.registerTool('get_room_availability', {
    title: 'Check room availability',
    description: 'Get available 30-minute slots for a meeting room on a future date.',
    inputSchema: {
      room_id: z.number().int().positive().describe('Meeting room ID'),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Date in YYYY-MM-DD format'),
    },
    securitySchemes: noAuthSecurity,
    _meta: { securitySchemes: noAuthSecurity },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ room_id, date }) => toolResult(() =>
    apiRequest(`meeting-rooms/${room_id}/availability`, { query: { date } })
  ));

  server.registerTool('list_booking_reasons', {
    title: 'List booking reasons',
    description: 'List valid reason IDs to use when creating a meeting-room booking.',
    inputSchema: {},
    securitySchemes: noAuthSecurity,
    _meta: { securitySchemes: noAuthSecurity },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => toolResult(() => apiRequest('booking-reasons')));

  server.registerTool('list_my_bookings', {
    title: 'List my bookings',
    description: 'List bookings owned by the connected Meeting Room account.',
    inputSchema: {
      room_id: z.number().int().positive().optional(),
      status: z.number().int().min(0).max(4).optional(),
      from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      per_page: z.number().int().min(1).max(100).optional(),
    },
    securitySchemes: readSecurity,
    _meta: { securitySchemes: readSecurity },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (args, extra) => {
    const auth = authenticated(extra, ['meeting:read']);
    if (!auth) return oauthError(['meeting:read']);
    return toolResult(() => apiRequest('bookings', { query: args, token: auth.token }));
  });

  server.registerTool('get_booking', {
    title: 'Get my booking',
    description: 'Get one booking owned by the connected Meeting Room account.',
    inputSchema: {
      booking_id: z.number().int().positive().describe('Booking ID'),
    },
    securitySchemes: readSecurity,
    _meta: { securitySchemes: readSecurity },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ booking_id }, extra) => {
    const auth = authenticated(extra, ['meeting:read']);
    if (!auth) return oauthError(['meeting:read']);
    return toolResult(() => apiRequest(`bookings/${booking_id}`, { token: auth.token }));
  });

  server.registerTool('create_booking', {
    title: 'Create meeting-room booking',
    description: 'Create a booking for the connected Meeting Room account. Times use HH:mm:ss.',
    inputSchema: {
      room_id: z.number().int().positive(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      start_time: z.string().regex(/^\d{2}:\d{2}:\d{2}$/),
      end_time: z.string().regex(/^\d{2}:\d{2}:\d{2}$/),
      title: z.string().min(1).max(255),
      reason_id: z.number().int().positive(),
      remark: z.string().optional(),
    },
    securitySchemes: writeSecurity,
    _meta: { securitySchemes: writeSecurity },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, (body, extra) => {
    const auth = authenticated(extra, ['meeting:write']);
    if (!auth) return oauthError(['meeting:write']);
    return toolResult(() => apiRequest('bookings', {
      method: 'POST',
      body,
      token: auth.token,
    }));
  });

  server.registerTool('cancel_booking', {
    title: 'Cancel my booking',
    description: 'Cancel a booking owned by the connected Meeting Room account.',
    inputSchema: {
      booking_id: z.number().int().positive().describe('Booking ID'),
    },
    securitySchemes: writeSecurity,
    _meta: { securitySchemes: writeSecurity },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, ({ booking_id }, extra) => {
    const auth = authenticated(extra, ['meeting:write']);
    if (!auth) return oauthError(['meeting:write']);
    return toolResult(() => apiRequest(`bookings/${booking_id}/cancel`, {
      method: 'PATCH',
      token: auth.token,
    }));
  });

  return server;
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

const httpServer = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;

  if (path === '/health' && req.method === 'GET') {
    json(res, 200, { status: 'ok' });
    return;
  }

  if (path === '/.well-known/oauth-protected-resource' && req.method === 'GET') {
    json(res, 200, {
      resource: mcpPublicUrl.toString(),
      authorization_servers: [authorizationServerUrl.toString()],
      scopes_supported: ['meeting:read', 'meeting:write'],
      resource_name: 'Meeting Room Booking',
    });
    return;
  }

  if (path !== '/mcp') {
    json(res, 404, { message: 'Use /mcp for MCP requests.' });
    return;
  }

  const authorization = req.headers.authorization;
  if (authorization) {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      json(res, 401, { error: 'invalid_token' }, {
        'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl}"`,
      });
      return;
    }
    try {
      req.auth = await verifyAccessToken(match[1]);
    } catch {
      json(res, 401, { error: 'invalid_token' }, {
        'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl}"`,
      });
      return;
    }
  }

  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    server.close().catch(() => console.error('Failed to close MCP connection.'));
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch {
    console.error('Failed to handle MCP HTTP request.');
    if (!res.headersSent) {
      json(res, 500, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32603, message: 'Internal server error' },
      });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

httpServer.on('error', (error) => {
  console.error(`HTTP server failed: ${error.code || 'unknown error'}`);
  process.exit(1);
});

httpServer.listen(port, host, () => {
  console.error(`MCP server ready: ${mcpPublicUrl}`);
  console.error(`Health check: http://${host}:${port}/health`);
});
