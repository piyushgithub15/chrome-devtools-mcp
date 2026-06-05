#!/usr/bin/env node
/**
 * HTTP entrypoint for on-demand-goose-execution.
 *
 * Streamable MCP at /mcp?redis_channel=<messageId>_chrome_mcp
 * Each MCP session spawns an isolated Chrome subprocess and publishes
 * tool.start / tool.done to Redis via tapTransport (MCP stdio uses Content-Length
 * framing, not line-delimited JSON).
 */

import {createClient} from 'redis';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {InMemoryEventStore, proxyServer, startHTTPServer, tapTransport} from 'mcp-proxy';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const REQUEST_TIMEOUT = Number(process.env.MCP_REQUEST_TIMEOUT ?? 3_600_000);
const CONNECTION_TIMEOUT = Number(process.env.MCP_CONNECTION_TIMEOUT ?? 120_000);

const CHROME_MCP_BIN = '/app/build/src/bin/chrome-devtools-mcp.js';

const CHROME_ARGS = [
  CHROME_MCP_BIN,
  '--headless',
  '--isolated',
  '--executablePath=/usr/local/bin/chrome',
  '--chrome-arg=--no-sandbox',
  '--chrome-arg=--disable-setuid-sandbox',
  '--chrome-arg=--disable-dev-shm-usage',
];

/** @param {import('node:http').IncomingMessage | undefined} req */
function redisChannelFromRequest(req) {
  if (!req?.url) {
    return '';
  }
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    return url.searchParams.get('redis_channel')?.trim() ?? '';
  } catch {
    return '';
  }
}

/** @param {string} channel */
async function createRedisPublisher(channel) {
  if (!channel) {
    return {publish: async () => {}, close: async () => {}};
  }
  const redis = createClient({url: REDIS_URL});
  redis.on('error', err => {
    console.error('[goose-mcp] Redis error:', err.message);
  });
  await redis.connect();
  console.error(
    `[goose-mcp] Publishing tool events to "${channel}" (${REDIS_URL})`,
  );
  return {
    publish: async payload => {
      await redis.publish(
        channel,
        JSON.stringify({
          ...payload,
          channel,
          ts: new Date().toISOString(),
        }),
      );
    },
    close: async () => {
      await redis.quit();
    },
  };
}

/** @param {import('node:http').IncomingMessage | undefined} req */
async function createServer(req) {
  const redisChannel = redisChannelFromRequest(req);
  console.error(
    `[goose-mcp] session start redis_channel=${redisChannel || '(none)'}`,
  );

  const pub = await createRedisPublisher(redisChannel);
  /** @type {Map<string | number, {tool: string, t0: number}>} */
  const pending = new Map();

  const client = new Client(
    {name: 'goose-chrome-mcp', version: '1.0.0'},
    {capabilities: {}},
  );

  const baseTransport = new StdioClientTransport({
    command: process.execPath,
    args: CHROME_ARGS,
    env: process.env,
    stderr: 'inherit',
  });

  const transport = tapTransport(baseTransport, event => {
    if (
      event.type === 'send' &&
      event.message &&
      typeof event.message === 'object' &&
      'method' in event.message &&
      event.message.method === 'tools/call' &&
      event.message.id != null
    ) {
      const tool = event.message.params?.name ?? 'unknown';
      pending.set(event.message.id, {tool, t0: Date.now()});
      void pub.publish({type: 'tool.start', id: event.message.id, tool});
      return;
    }

    if (
      event.type === 'onmessage' &&
      event.message &&
      typeof event.message === 'object' &&
      'id' in event.message &&
      event.message.id != null &&
      pending.has(event.message.id)
    ) {
      const p = pending.get(event.message.id);
      pending.delete(event.message.id);
      const durationMs = Date.now() - p.t0;
      if ('error' in event.message && event.message.error) {
        const err = event.message.error;
        void pub.publish({
          type: 'tool.error',
          id: event.message.id,
          tool: p.tool,
          durationMs,
          error:
            typeof err === 'object' && err && 'message' in err
              ? String(err.message)
              : JSON.stringify(err),
        });
      } else {
        void pub.publish({
          type: 'tool.done',
          id: event.message.id,
          tool: p.tool,
          durationMs,
          ok: true,
        });
      }
    }

    if (event.type === 'close' || event.type === 'onclose') {
      void pub.close();
    }
  });

  await client.connect(transport, {timeout: CONNECTION_TIMEOUT});

  const serverVersion = client.getServerVersion();
  const serverCapabilities = client.getServerCapabilities();

  const server = new Server(serverVersion, {
    capabilities: serverCapabilities,
  });

  await proxyServer({
    client,
    server,
    serverCapabilities,
    requestTimeout: REQUEST_TIMEOUT,
  });

  return server;
}

await startHTTPServer({
  createServer,
  eventStore: new InMemoryEventStore(),
  host: HOST,
  port: PORT,
  streamEndpoint: '/mcp',
  sseEndpoint: null,
  stateless: true,
  requestTimeout: REQUEST_TIMEOUT,
});

console.error(`[goose-mcp] listening on http://${HOST}:${PORT}/mcp`);
