/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type fs from 'node:fs';

import type {parseArguments} from './bin/chrome-devtools-mcp-cli-options.js';
import type {Channel} from './browser.js';
import {BrowserManager} from './browser.js';
import {loadIssueDescriptions} from './issue-descriptions.js';
import {logger} from './logger.js';
import {McpContext} from './McpContext.js';
import {Mutex} from './Mutex.js';
import {SessionManager} from './SessionManager.js';
import {ClearcutLogger} from './telemetry/ClearcutLogger.js';
import {FilePersistence} from './telemetry/persistence.js';
import {
  McpServer,
  type CallToolResult,
  type Browser,
  type Root,
  SetLevelRequestSchema,
  ListRootsResultSchema,
  RootsListChangedNotificationSchema,
} from './third_party/index.js';
import {ToolHandler} from './ToolHandler.js';
import type {DefinedPageTool, ToolDefinition} from './tools/ToolDefinition.js';
import {createTools} from './tools/tools.js';
import {VERSION} from './version.js';

export {buildFlag} from './ToolHandler.js';
export {SessionManager} from './SessionManager.js';

type ServerArgs = ReturnType<typeof parseArguments>;

const DEFAULT_SESSION_MAX_LIFETIME_MS = 1_500_000;

/**
 * Launches a new Chrome (or attaches to an existing one) according to the CLI
 * args, using the provided BrowserManager to own the resulting instance.
 */
async function launchOrConnectBrowser(
  serverArgs: ServerArgs,
  logFile: fs.WriteStream | undefined,
  browserManager: BrowserManager,
): Promise<Browser> {
  const chromeArgs: string[] = (serverArgs.chromeArg ?? []).map(String);
  const ignoreDefaultChromeArgs: string[] = (
    serverArgs.ignoreDefaultChromeArg ?? []
  ).map(String);
  if (serverArgs.proxyServer) {
    chromeArgs.push(`--proxy-server=${serverArgs.proxyServer}`);
  }
  const devtools = serverArgs.experimentalDevtools ?? false;
  return serverArgs.browserUrl ||
    serverArgs.wsEndpoint ||
    serverArgs.autoConnect
    ? await browserManager.ensureBrowserConnected({
        browserURL: serverArgs.browserUrl,
        wsEndpoint: serverArgs.wsEndpoint,
        wsHeaders: serverArgs.wsHeaders,
        // Important: only pass channel, if autoConnect is true.
        channel: serverArgs.autoConnect
          ? (serverArgs.channel as Channel)
          : undefined,
        userDataDir: serverArgs.userDataDir,
        devtools,
      })
    : await browserManager.ensureBrowserLaunched({
        headless: serverArgs.headless,
        executablePath: serverArgs.executablePath,
        channel: serverArgs.channel as Channel,
        isolated: serverArgs.isolated ?? false,
        userDataDir: serverArgs.userDataDir,
        logFile,
        viewport: serverArgs.viewport,
        chromeArgs,
        ignoreDefaultChromeArgs,
        acceptInsecureCerts: serverArgs.acceptInsecureCerts,
        devtools,
        enableExtensions: serverArgs.categoryExtensions,
        viaCli: serverArgs.viaCli,
      });
}

async function createContextForBrowser(
  serverArgs: ServerArgs,
  browser: Browser,
): Promise<McpContext> {
  const proxyCredentials =
    serverArgs.proxyUsername && serverArgs.proxyPassword
      ? {
          username: String(serverArgs.proxyUsername),
          password: String(serverArgs.proxyPassword),
        }
      : undefined;
  return McpContext.from(browser, logger, {
    experimentalDevToolsDebugging: serverArgs.experimentalDevtools ?? false,
    experimentalIncludeAllPages: serverArgs.experimentalIncludeAllPages,
    performanceCrux: serverArgs.performanceCrux,
    proxyCredentials,
  });
}

/**
 * Creates a SessionManager that launches an independent browser per sessionId.
 * Share a single instance across MCP connections so all clients address the
 * same pool of browsers by sessionId.
 */
export function createSessionManager(
  serverArgs: ServerArgs,
  options: {logFile?: fs.WriteStream} = {},
): SessionManager {
  const lifetimeMs = Number(
    process.env['MCP_SESSION_MAX_LIFETIME_MS'] ??
      DEFAULT_SESSION_MAX_LIFETIME_MS,
  );
  return new SessionManager({
    lifetimeMs,
    logger,
    buildContext: async () => {
      const browserManager = new BrowserManager();
      const browser = await launchOrConnectBrowser(
        serverArgs,
        options.logFile,
        browserManager,
      );
      const context = await createContextForBrowser(serverArgs, browser);
      return {context, browserManager};
    },
  });
}

export async function createMcpServer(
  serverArgs: ReturnType<typeof parseArguments>,
  options: {
    logFile?: fs.WriteStream;
    // When sessionIdRouting is enabled, share one SessionManager across all MCP
    // connections so every client addresses the same pool of browsers by
    // sessionId. If omitted, a private SessionManager is created and owned by
    // this server.
    sessionManager?: SessionManager;
  },
) {
  if (serverArgs.usageStatistics && !ClearcutLogger.get()) {
    ClearcutLogger.initialize({
      persistence: new FilePersistence(),
      logFile: serverArgs.logFile,
      appVersion: VERSION,
      clearcutEndpoint: serverArgs.clearcutEndpoint,
      clearcutForceFlushIntervalMs: serverArgs.clearcutForceFlushIntervalMs,
      clearcutIncludePidHeader: serverArgs.clearcutIncludePidHeader,
    });
  }

  const server = new McpServer(
    {
      name: 'chrome_devtools',
      title: 'Chrome DevTools MCP server',
      version: VERSION,
    },
    {capabilities: {logging: {}}},
  );
  server.server.setRequestHandler(SetLevelRequestSchema, () => {
    return {};
  });

  const sessionIdRouting = serverArgs.sessionIdRouting ?? false;
  const sessionManager = sessionIdRouting
    ? (options.sessionManager ?? createSessionManager(serverArgs, options))
    : undefined;
  const ownsSessionManager = sessionIdRouting && !options.sessionManager;

  // The latest workspace roots reported by the client, applied to every context
  // (single-session, or each per-sessionId context).
  let latestRoots: Root[] | undefined;
  function applyRootsToAllContexts(): void {
    if (sessionManager) {
      sessionManager.forEachContext(ctx => ctx.setRoots(latestRoots));
    } else {
      context?.setRoots(latestRoots);
    }
  }

  const updateRoots = async () => {
    if (!server.server.getClientCapabilities()?.roots) {
      return;
    }
    try {
      const roots = await server.server.request(
        {method: 'roots/list'},
        ListRootsResultSchema,
      );
      latestRoots = roots.roots;
      applyRootsToAllContexts();
    } catch (e) {
      logger('Failed to list roots', e);
    }
  };

  server.server.oninitialized = () => {
    const clientName = server.server.getClientVersion()?.name;
    if (clientName) {
      ClearcutLogger.get()?.setClientName(clientName);
    }
    if (server.server.getClientCapabilities()?.roots) {
      void updateRoots();
      server.server.setNotificationHandler(
        RootsListChangedNotificationSchema,
        () => {
          void updateRoots();
        },
      );
    }
  };

  const browserManager = new BrowserManager();
  // Single-session browser/context (used when sessionIdRouting is off).
  let context: McpContext;
  const toolMutex = new Mutex();

  async function getContext(sessionId?: string): Promise<McpContext> {
    if (sessionManager) {
      if (!sessionId) {
        throw new Error(
          'A "sessionId" argument is required when sessionId routing is enabled.',
        );
      }
      const ctx = await sessionManager.getContext(sessionId);
      ctx.setRoots(latestRoots);
      return ctx;
    }

    const browser = await launchOrConnectBrowser(
      serverArgs,
      options.logFile,
      browserManager,
    );
    if (context?.browser !== browser) {
      context = await createContextForBrowser(serverArgs, browser);
      context.setRoots(latestRoots);
      await updateRoots();
    }
    return context;
  }

  function getMutex(sessionId?: string): Mutex {
    if (sessionManager) {
      if (!sessionId) {
        throw new Error(
          'A "sessionId" argument is required when sessionId routing is enabled.',
        );
      }
      return sessionManager.getMutex(sessionId);
    }
    return toolMutex;
  }

  function registerTool(tool: ToolDefinition | DefinedPageTool): void {
    const toolHandler = new ToolHandler(tool, serverArgs, getContext, getMutex);

    if (!toolHandler.shouldRegister) {
      return;
    }

    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: toolHandler.registeredInputSchema,
        annotations: tool.annotations,
      },
      async (params): Promise<CallToolResult> => {
        return await toolHandler.handle(params);
      },
    );
  }

  const tools = createTools(serverArgs);
  for (const tool of tools) {
    registerTool(tool);
  }

  await loadIssueDescriptions();

  // Tears down everything this server owns. In sessionId-routing mode the
  // browsers live in the SessionManager: only close them if this server created
  // (and thus owns) it; a shared manager is closed by its owner instead.
  async function close(): Promise<void> {
    if (sessionManager) {
      if (ownsSessionManager) {
        await sessionManager.closeAll();
      }
      return;
    }
    context?.dispose();
    await browserManager.close();
  }

  return {server, close};
}

export const logDisclaimers = (args: ReturnType<typeof parseArguments>) => {
  console.error(
    `chrome-devtools-mcp exposes content of the browser instance to the MCP clients allowing them to inspect,
debug, and modify any data in the browser or DevTools.
Avoid sharing sensitive or personal information that you do not want to share with MCP clients.`,
  );

  if (!args.slim && args.performanceCrux) {
    console.error(
      `Performance tools may send trace URLs to the Google CrUX API to fetch real-user experience data. To disable, run with --no-performance-crux.`,
    );
  }

  if (!args.slim && args.usageStatistics) {
    console.error(
      `
Google collects usage statistics to improve Chrome DevTools MCP. To opt-out, run with --no-usage-statistics.
For more details, visit: https://github.com/ChromeDevTools/chrome-devtools-mcp#usage-statistics`,
    );
  }
};
