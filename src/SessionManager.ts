/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BrowserManager} from './browser.js';
import type {McpContext} from './McpContext.js';
import {Mutex} from './Mutex.js';
import type {Debugger} from './third_party/index.js';

interface SessionEntry {
  // Serializes tool calls that target this session. Created eagerly so callers
  // can lock before the (lazily launched) browser exists.
  mutex: Mutex;
  browserManager?: BrowserManager;
  context?: McpContext;
  // Absolute lifetime timer; closes the session this long after its browser was
  // first created, regardless of activity.
  lifetimeTimer?: ReturnType<typeof setTimeout>;
}

export interface SessionManagerOptions {
  // Creates a fresh, independent browser + context for a new session.
  buildContext: () => Promise<{
    context: McpContext;
    browserManager: BrowserManager;
  }>;
  // Hard cap on a session's lifetime in milliseconds. 0 disables the cap.
  lifetimeMs: number;
  logger: Debugger;
}

/**
 * Owns one browser per `sessionId`. Tool calls carry a `sessionId` and are
 * routed to the matching browser, lazily launching it on first use and
 * auto-closing it after a fixed lifetime. A single process can therefore serve
 * many isolated browsers concurrently over one MCP connection.
 */
export class SessionManager {
  #options: SessionManagerOptions;
  #sessions = new Map<string, SessionEntry>();
  // De-dupes concurrent first-time context builds for the same session.
  #building = new Map<string, Promise<McpContext>>();

  constructor(options: SessionManagerOptions) {
    this.#options = options;
  }

  #ensureEntry(sessionId: string): SessionEntry {
    let entry = this.#sessions.get(sessionId);
    if (!entry) {
      entry = {mutex: new Mutex()};
      this.#sessions.set(sessionId, entry);
    }
    return entry;
  }

  /**
   * Returns the per-session mutex, creating the session slot if needed. Safe to
   * call before the browser exists so callers can lock first, then build.
   */
  getMutex(sessionId: string): Mutex {
    return this.#ensureEntry(sessionId).mutex;
  }

  async getContext(sessionId: string): Promise<McpContext> {
    const entry = this.#ensureEntry(sessionId);
    if (entry.context && entry.browserManager?.browser?.connected) {
      return entry.context;
    }

    const inFlight = this.#building.get(sessionId);
    if (inFlight) {
      return inFlight;
    }

    const promise = (async () => {
      this.#options.logger(`Creating browser session ${sessionId}`);
      const {context, browserManager} = await this.#options.buildContext();
      entry.context = context;
      entry.browserManager = browserManager;
      if (this.#options.lifetimeMs > 0) {
        entry.lifetimeTimer = setTimeout(() => {
          this.#options.logger(
            `Session ${sessionId} reached max lifetime, closing browser`,
          );
          void this.close(sessionId);
        }, this.#options.lifetimeMs);
        entry.lifetimeTimer.unref();
      }
      return context;
    })().finally(() => {
      this.#building.delete(sessionId);
    });
    this.#building.set(sessionId, promise);
    return promise;
  }

  forEachContext(callback: (context: McpContext) => void): void {
    for (const entry of this.#sessions.values()) {
      if (entry.context) {
        callback(entry.context);
      }
    }
  }

  hasSession(sessionId: string): boolean {
    return this.#sessions.has(sessionId);
  }

  get size(): number {
    return this.#sessions.size;
  }

  async close(sessionId: string): Promise<void> {
    const entry = this.#sessions.get(sessionId);
    if (!entry) {
      return;
    }
    this.#sessions.delete(sessionId);
    if (entry.lifetimeTimer) {
      clearTimeout(entry.lifetimeTimer);
    }
    this.#options.logger(`Closing browser session ${sessionId}`);
    entry.context?.dispose();
    await entry.browserManager?.close();
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.#sessions.keys()].map(sessionId => this.close(sessionId)),
    );
  }
}
