import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import type { OmniFocus } from '../../lib/omnifocus.js';
import { registerApps, STATS_DASHBOARD_URI } from '../apps.js';
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
