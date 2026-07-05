import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import type { OmniFocus } from '../../lib/omnifocus.js';
import { APP_TOOL_DESCRIPTORS, registerApps, STATS_DASHBOARD_URI } from '../apps.js';
import { STATS_DASHBOARD_HTML } from '../apps/stats-dashboard.js';

/**
 * Exercises the MCP Apps registration without OmniFocus, osascript, or a real
 * McpServer: a stub server captures registerTool/registerResource calls so we
 * can assert on the registered metadata and drive the handlers directly. Like
 * server.test.ts, this file avoids `vi` so it passes under both vitest and
 * bun's native test runner.
 */

interface CapturedTool {
  name: string;
  config: {
    title?: string;
    description?: string;
    annotations?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  };
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>;
}

interface CapturedResource {
  name: string;
  uri: string;
  config: { description?: string; mimeType?: string };
  read: (
    uri: URL,
    extra: unknown
  ) => Promise<{
    contents: Array<{ uri: string; mimeType?: string; text?: string }>;
  }>;
}

function makeStubServer(): {
  server: McpServer;
  tools: CapturedTool[];
  resources: CapturedResource[];
} {
  const tools: CapturedTool[] = [];
  const resources: CapturedResource[] = [];
  const server = {
    registerTool: (name: string, config: CapturedTool['config'], handler: unknown) => {
      const tool = { name, config, handler: handler as CapturedTool['handler'] };
      tools.push(tool);
      return tool;
    },
    registerResource: (
      name: string,
      uri: string,
      config: CapturedResource['config'],
      read: unknown
    ) => {
      const resource = { name, uri, config, read: read as CapturedResource['read'] };
      resources.push(resource);
      return resource;
    },
  };
  return { server: server as unknown as McpServer, tools, resources };
}

const STATS_METHODS = ['getTaskStats', 'getProjectStats', 'getTagStats'] as const;

function makeStatsMockOf(returns: Partial<Record<string, unknown>> = {}): {
  of: OmniFocus;
  calls: string[];
} {
  const calls: string[] = [];
  const of: Record<string, unknown> = {};
  for (const method of STATS_METHODS) {
    of[method] = async () => {
      calls.push(method);
      const value = returns[method];
      if (value instanceof Error) throw value;
      return value;
    };
  }
  return { of: of as unknown as OmniFocus, calls };
}

describe('registerApps resource registration', () => {
  it('registers the dashboard template under the ui:// URI with the MCP Apps mime type', () => {
    const { server, resources } = makeStubServer();
    registerApps(server, makeStatsMockOf().of);
    expect(resources).toHaveLength(1);
    expect(resources[0].uri).toBe('ui://omnifocus/stats-dashboard.html');
    expect(resources[0].uri).toBe(STATS_DASHBOARD_URI);
    expect(resources[0].config.mimeType).toBe('text/html;profile=mcp-app');
  });

  it('serves the self-contained dashboard HTML from the read callback', async () => {
    const { server, resources } = makeStubServer();
    registerApps(server, makeStatsMockOf().of);
    const result = await resources[0].read(new URL(STATS_DASHBOARD_URI), {});
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].uri).toBe(STATS_DASHBOARD_URI);
    expect(result.contents[0].mimeType).toBe('text/html;profile=mcp-app');
    expect(result.contents[0].text).toBe(STATS_DASHBOARD_HTML);
  });
});

describe('stats dashboard HTML template', () => {
  it('is a self-contained document that speaks the MCP Apps handshake', () => {
    expect(STATS_DASHBOARD_HTML).toContain('<!doctype html>');
    expect(STATS_DASHBOARD_HTML).toContain('ui/initialize');
    expect(STATS_DASHBOARD_HTML).toContain('ui/notifications/initialized');
    expect(STATS_DASHBOARD_HTML).toContain('ui/notifications/tool-result');
    expect(STATS_DASHBOARD_HTML).toContain("protocolVersion: '2026-01-26'");
  });

  it('references no external network resources (strict host CSP)', () => {
    expect(STATS_DASHBOARD_HTML).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    expect(STATS_DASHBOARD_HTML).not.toContain('<link');
    expect(STATS_DASHBOARD_HTML).not.toContain('src=');
    expect(STATS_DASHBOARD_HTML).not.toContain('@import');
    expect(STATS_DASHBOARD_HTML).not.toContain('fetch(');
  });

  it('stays within the inline size budget', () => {
    expect(Buffer.byteLength(STATS_DASHBOARD_HTML, 'utf8')).toBeLessThan(60_000);
  });
});

/**
 * Behavioural harness for the inlined widget script. There is no DOM in the
 * test environment (the suite runs under both vitest and bun's native runner,
 * so it can't depend on jsdom or `vi`), so we run the IIFE against a minimal
 * fake window/document. This is enough to exercise the postMessage JSON-RPC
 * bridge: the source-origin guard, tool-result rendering, and theme handling —
 * the parts a string assertion can't actually verify.
 */
interface FakeNode {
  tagName: string;
  className: string;
  textContent: string;
  attributes: Record<string, string>;
  children: FakeNode[];
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
  appendChild(child: FakeNode): FakeNode;
  getBoundingClientRect(): { height: number };
}

function makeNode(tagName: string): FakeNode {
  const node: FakeNode = {
    tagName,
    className: '',
    textContent: '',
    attributes: {},
    children: [],
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return name in this.attributes ? this.attributes[name] : null;
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    getBoundingClientRect() {
      return { height: 200 };
    },
  };
  return node;
}

interface WidgetHarness {
  postedToParent: Array<Record<string, unknown>>;
  documentElement: FakeNode;
  root: FakeNode;
  /** Deliver a postMessage event to the widget's window listener. */
  dispatch(data: unknown, source: unknown): void;
  /** The window object the widget treats as its host frame. */
  parentWindow: unknown;
}

/** Pull the inline <script> body out of the template. */
function extractWidgetScript(): string {
  const match = STATS_DASHBOARD_HTML.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('widget script block not found');
  return match[1];
}

function runWidget(): WidgetHarness {
  const postedToParent: Array<Record<string, unknown>> = [];
  const documentElement = makeNode('html');
  const root = makeNode('main');
  let messageListener: ((event: { data: unknown; source: unknown }) => void) | undefined;

  const parentWindow = {
    postMessage(message: Record<string, unknown>) {
      postedToParent.push(message);
    },
  };

  const fakeDocument = {
    documentElement,
    getElementById: (id: string) => (id === 'root' ? root : null),
    createElement: (tag: string) => makeNode(tag),
    createElementNS: (_ns: string, tag: string) => makeNode(tag),
  };

  const fakeWindow: Record<string, unknown> = {
    parent: parentWindow,
    addEventListener(type: string, listener: (event: { data: unknown; source: unknown }) => void) {
      if (type === 'message') messageListener = listener;
    },
  };

  // Run the IIFE with our fakes shadowing the real globals.
  const script = extractWidgetScript();
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'Promise', script)(fakeWindow, fakeDocument, Promise);

  return {
    postedToParent,
    documentElement,
    root,
    parentWindow,
    dispatch(data, source) {
      if (!messageListener) throw new Error('widget never registered a message listener');
      messageListener({ data, source });
    },
  };
}

const okToolResult = {
  structuredContent: {
    tasks: { totalTasks: 5, overdueActiveTasks: 0 },
    projects: {},
    tags: {},
  },
};

describe('stats dashboard postMessage bridge (behavioural)', () => {
  it('ignores JSON-RPC messages that do not come from the host (window.parent)', () => {
    const w = runWidget();
    const postedBefore = w.postedToParent.length;
    // A well-formed tool-result, but from a hostile frame that is not the parent.
    w.dispatch(
      { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: okToolResult },
      { postMessage() {} }
    );
    // Nothing rendered, nothing sent back: the message was dropped.
    expect(w.root.getAttribute('aria-busy')).toBe('true');
    expect(w.postedToParent.length).toBe(postedBefore);
  });

  it('processes a tool-result that arrives from window.parent', () => {
    const w = runWidget();
    w.dispatch(
      { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: okToolResult },
      w.parentWindow
    );
    // Data rendered (aria-busy cleared) and a size-changed notification sent.
    expect(w.root.getAttribute('aria-busy')).toBe('false');
    const methods = w.postedToParent.map((m) => m.method);
    expect(methods).toContain('ui/notifications/size-changed');
  });

  it('answers a host ping only when it comes from the parent', () => {
    const w = runWidget();
    w.dispatch({ jsonrpc: '2.0', id: 99, method: 'ping' }, { postMessage() {} });
    expect(w.postedToParent.some((m) => m.id === 99)).toBe(false);
    w.dispatch({ jsonrpc: '2.0', id: 99, method: 'ping' }, w.parentWindow);
    expect(w.postedToParent.some((m) => m.id === 99 && m.result !== undefined)).toBe(true);
  });
});

describe('stats dashboard theme handling (behavioural)', () => {
  it('sets data-theme when the host sends an explicit theme', () => {
    const w = runWidget();
    w.dispatch(
      {
        jsonrpc: '2.0',
        method: 'ui/notifications/host-context-changed',
        params: { theme: 'dark' },
      },
      w.parentWindow
    );
    expect(w.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('clears data-theme when the host reverts to follow-system', () => {
    const w = runWidget();
    w.dispatch(
      {
        jsonrpc: '2.0',
        method: 'ui/notifications/host-context-changed',
        params: { theme: 'dark' },
      },
      w.parentWindow
    );
    expect(w.documentElement.getAttribute('data-theme')).toBe('dark');
    // Host now sends a context with no explicit theme.
    w.dispatch(
      { jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: {} },
      w.parentWindow
    );
    expect(w.documentElement.getAttribute('data-theme')).toBe(null);
  });
});

describe('get_stats_dashboard tool registration', () => {
  it('registers with a title, READ-style annotations, and the ui resource link', () => {
    const { server, tools } = makeStubServer();
    registerApps(server, makeStatsMockOf().of);
    expect(tools).toHaveLength(1);
    const tool = tools[0];
    expect(tool.name).toBe('get_stats_dashboard');
    expect(tool.config.title).toBe('Stats dashboard');
    expect(tool.config.annotations).toMatchObject({
      title: 'Stats dashboard',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(tool.config._meta?.ui).toMatchObject({ resourceUri: STATS_DASHBOARD_URI });
    // registerAppTool mirrors the URI into the legacy key for older hosts.
    expect(tool.config._meta?.['ui/resourceUri']).toBe(STATS_DASHBOARD_URI);
  });
});

describe('APP_TOOL_DESCRIPTORS (search_tools discoverability)', () => {
  it('lists get_stats_dashboard so search_tools can surface it', () => {
    expect(APP_TOOL_DESCRIPTORS.map((d) => d.name)).toContain('get_stats_dashboard');
  });

  it('does not drift from the tools registerApps actually registers', () => {
    // Every registered app tool must have a descriptor and vice versa, and the
    // descriptions must match — so search_tools shows exactly what's callable.
    const { server, tools } = makeStubServer();
    registerApps(server, makeStatsMockOf().of);
    const registered = tools
      .map((t) => ({ name: t.name, description: t.config.description ?? '' }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const descriptors = APP_TOOL_DESCRIPTORS.map((d) => ({
      name: d.name,
      description: d.description,
    })).sort((a, b) => a.name.localeCompare(b.name));
    expect(descriptors).toEqual(registered);
  });
});

describe('get_stats_dashboard handler', () => {
  it('combines all three stats calls into one payload with structuredContent', async () => {
    const taskStats = { totalTasks: 12, flaggedTasks: 3 };
    const projectStats = { totalProjects: 4, activeProjects: 2 };
    const tagStats = { totalTags: 9, mostUsedTags: [{ name: 'errand', taskCount: 5 }] };
    const { of, calls } = makeStatsMockOf({
      getTaskStats: taskStats,
      getProjectStats: projectStats,
      getTagStats: tagStats,
    });
    const { server, tools } = makeStubServer();
    registerApps(server, of);

    const result = await tools[0].handler({}, {});
    expect([...calls].sort()).toEqual(['getProjectStats', 'getTagStats', 'getTaskStats']);
    const combined = { tasks: taskStats, projects: projectStats, tags: tagStats };
    expect(result.structuredContent).toEqual(combined);
    // Non-Apps hosts still get the combined JSON as pretty-printed text.
    const block = result.content[0] as { type: string; text: string };
    expect(block.type).toBe('text');
    expect(JSON.parse(block.text)).toEqual(combined);
    expect(result.isError).toBeUndefined();
  });

  it('maps failures to isError results with the structured CLI error JSON', async () => {
    const { of } = makeStatsMockOf({
      getTaskStats: { totalTasks: 1 },
      getProjectStats: new Error('OmniFocus is not running'),
      getTagStats: { totalTags: 0 },
    });
    const { server, tools } = makeStubServer();
    registerApps(server, of);

    const result = await tools[0].handler({}, {});
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.error).toMatchObject({
      name: 'omnifocus_error',
      detail: 'OmniFocus is not running',
      statusCode: 500,
    });
  });
});
