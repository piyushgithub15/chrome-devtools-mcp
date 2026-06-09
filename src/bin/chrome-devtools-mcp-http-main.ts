/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import '../polyfill.js';

import {randomUUID} from 'node:crypto';
import http from 'node:http';
import process from 'node:process';

import {
  createMcpServer,
  createSessionManager,
  logDisclaimers,
} from '../index.js';
import {logger, saveLogsToFile} from '../logger.js';
import {StreamableHTTPServerTransport} from '../third_party/index.js';
import {checkForUpdates} from '../utils/check-for-updates.js';
import {VERSION} from '../version.js';

import {parseArguments} from './chrome-devtools-mcp-cli-options.js';

await checkForUpdates(
  'Run `npm install chrome-devtools-mcp@latest` to update.',
);

const args = parseArguments(VERSION);
const logFile = args.logFile ? saveLogsToFile(args.logFile) : undefined;

const PORT = Number(process.env['PORT'] ?? 8080);
const HOST = process.env['HOST'] ?? '0.0.0.0';
const MCP_PATH = process.env['MCP_PATH'] ?? '/mcp';

if (!args.sessionIdRouting) {
  console.error(
    'Note: starting HTTP server with --session-id-routing enabled. Every tool ' +
      'call must include a "sessionId" argument; each distinct value gets its ' +
      'own browser.',
  );
  args.sessionIdRouting = true;
}

if (process.env['CHROME_DEVTOOLS_MCP_CRASH_ON_UNCAUGHT'] !== 'true') {
  process.on('unhandledRejection', (reason, promise) => {
    logger('Unhandled promise rejection', promise, reason);
  });
}

// Browsers are keyed by the sessionId tool argument and shared across every MCP
// connection, so a single manager backs the whole process.
const sessionManager = createSessionManager(args, {logFile});

// Standard MCP transport registry keyed by the protocol Mcp-Session-Id. This is
// the connection/session layer; it is independent of the browser sessionId tool
// argument that selects a browser.
interface Connection {
  transport: StreamableHTTPServerTransport;
  close: () => Promise<void>;
}
const connections = new Map<string, Connection>();

function jsonRpcError(
  res: http.ServerResponse,
  status: number,
  message: string,
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, {'Content-Type': 'application/json'});
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: {code: -32000, message},
      id: null,
    }),
  );
}

async function openConnection(): Promise<StreamableHTTPServerTransport> {
  // Each MCP connection gets its own server instance, all sharing the one
  // SessionManager so they address the same pool of browsers by sessionId.
  const {server, close} = await createMcpServer(args, {
    logFile,
    sessionManager,
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: id => {
      connections.set(id, {transport, close});
    },
  });
  transport.onclose = () => {
    const id = transport.sessionId;
    if (id) {
      connections.delete(id);
    }
    // Closing the connection does NOT close any browsers: they belong to the
    // shared SessionManager and live until their lifetime cap (or an explicit
    // close), so other connections can keep using them.
    void close();
  };
  await server.connect(transport);
  return transport;
}

const httpServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`,
    );

    if (url.pathname === '/healthz') {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(
        JSON.stringify({
          status: 'ok',
          connections: connections.size,
          browsers: sessionManager.size,
        }),
      );
      return;
    }

    if (url.pathname !== MCP_PATH) {
      jsonRpcError(res, 404, `Not found. MCP endpoint is ${MCP_PATH}.`);
      return;
    }

    const mcpSessionId = req.headers['mcp-session-id'];
    const connectionId =
      typeof mcpSessionId === 'string' ? mcpSessionId : undefined;

    if (connectionId) {
      const connection = connections.get(connectionId);
      if (!connection) {
        jsonRpcError(res, 404, 'Unknown or expired Mcp-Session-Id.');
        return;
      }
      await connection.transport.handleRequest(req, res);
      return;
    }

    // No connection id: only a fresh `initialize` (POST) is valid, which starts
    // a new connection.
    if (req.method !== 'POST') {
      jsonRpcError(res, 400, 'Missing Mcp-Session-Id header.');
      return;
    }
    const transport = await openConnection();
    await transport.handleRequest(req, res);
  } catch (err) {
    logger('Error handling request', err);
    jsonRpcError(res, 500, 'Internal server error');
  }
});

let shuttingDown = false;
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger(`Shutting down (${reason})`);
  setTimeout(() => {
    logger('Shutdown timeout exceeded, forcing exit');
    process.exit(0);
  }, 10000).unref();
  httpServer.close();
  await sessionManager.closeAll();
  process.exit(0);
}
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGHUP', () => {
  void shutdown('SIGHUP');
});

httpServer.listen(PORT, HOST, () => {
  logger(
    `Chrome DevTools MCP HTTP server v${VERSION} listening on http://${HOST}:${PORT}${MCP_PATH} (browser per sessionId tool argument)`,
  );
  logDisclaimers(args);
});
