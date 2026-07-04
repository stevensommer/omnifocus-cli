import { describe, it, expect } from 'vitest';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  buildTools,
  SERVER_INSTRUCTIONS,
  startProgressHeartbeat,
  type ToolCallExtra,
  type ToolSpec,
} from '../server.js';
import type { OmniFocus } from '../../lib/omnifocus.js';

/**
 * These tests exercise the MCP tool catalogue without OmniFocus or osascript.
 * They build the catalogue against a hand-rolled mock OmniFocus (no `vi` — the
 * suite must pass under both `vitest` and bun's native `bun test` runner, and
 * we only depend on describe/it/expect, which both provide).
 */

interface Call {
  method: string;
  args: unknown[];
}

const OF_METHODS = [
  'listTasks',
  'getTask',
  'createTask',
  'updateTask',
  'deleteTask',
  'searchTasks',
  'getTaskStats',
  'listInboxTasks',
  'getInboxCount',
  'listProjects',
  'getProject',
  'createProject',
  'updateProject',
  'deleteProject',
  'getProjectStats',
  'listPerspectives',
  'getPerspectiveTasks',
  'listTags',
  'getTag',
  'createTag',
  'updateTag',
  'deleteTag',
  'getTagStats',
  'listFolders',
  'getFolder',
] as const;

function makeMockOf(returns: Partial<Record<string, unknown>> = {}): {
  of: OmniFocus;
  calls: Call[];
} {
  const calls: Call[] = [];
  const of: Record<string, unknown> = {};
  for (const method of OF_METHODS) {
    of[method] = async (...args: unknown[]) => {
      calls.push({ method, args });
      const value = method in returns ? returns[method] : undefined;
      if (value instanceof Error) throw value;
      return value;
    };
  }
  return { of: of as unknown as OmniFocus, calls };
}

function tool(tools: ToolSpec[], name: string): ToolSpec {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool "${name}" not found in catalogue`);
  return found;
}

async function callTool(
  tools: ToolSpec[],
  name: string,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  const result = await tool(tools, name).handler(args);
  const block = result.content[0] as { text: string };
  return JSON.parse(block.text);
}

// The full set of tool names the server is expected to expose. This doubles as
// documentation and as a drift guard: adding or removing a tool must update
// this list deliberately.
const EXPECTED_TOOL_NAMES = [
  'list_tasks',
  'get_task',
  'create_task',
  'update_task',
  'delete_task',
  'search_tasks',
  'get_task_stats',
  'list_inbox',
  'get_inbox_count',
  'list_projects',
  'get_project',
  'create_project',
  'update_project',
  'delete_project',
  'get_project_stats',
  'list_perspectives',
  'get_perspective_tasks',
  'list_tags',
  'get_tag',
  'create_tag',
  'update_tag',
  'delete_tag',
  'get_tag_stats',
  'list_folders',
  'get_folder',
  'search_tools',
];

describe('buildTools catalogue', () => {
  it('exposes exactly the expected tools', () => {
    const names = buildTools(makeMockOf().of).map((t) => t.name);
    expect([...names].sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  it('has unique, non-empty names', () => {
    const names = buildTools(makeMockOf().of).map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => n.length > 0)).toBe(true);
  });

  it('gives every tool a description, a schema object, and a handler', () => {
    for (const t of buildTools(makeMockOf().of)) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(typeof t.schema).toBe('object');
      expect(typeof t.handler).toBe('function');
    }
  });

  // Claude Desktop groups connector tools by their annotations (read-only vs
  // write/destructive) and displays the title; tools missing either fall into
  // an unlabelled "Other tools" bucket with raw snake_case names.
  it('gives every tool a title and complete annotations', () => {
    for (const t of buildTools(makeMockOf().of)) {
      expect(t.title.length).toBeGreaterThan(0);
      expect(typeof t.annotations.readOnlyHint).toBe('boolean');
      expect(typeof t.annotations.destructiveHint).toBe('boolean');
      expect(typeof t.annotations.idempotentHint).toBe('boolean');
      expect(t.annotations.openWorldHint).toBe(false);
    }
  });

  it('annotates tools consistently with their naming convention', () => {
    for (const t of buildTools(makeMockOf().of)) {
      const readOnly = /^(list_|get_|search_)/.test(t.name);
      expect(t.annotations.readOnlyHint, t.name).toBe(readOnly);
      const destructive = /^(update_|delete_)/.test(t.name);
      expect(t.annotations.destructiveHint, t.name).toBe(destructive);
    }
  });
});

describe('search_tools', () => {
  it('is part of the searchable catalogue (no drift from registered tools)', async () => {
    const tools = buildTools(makeMockOf().of);
    const { tools: matches } = (await callTool(tools, 'search_tools', {
      query: 'search_tools',
    })) as {
      tools: Array<{ name: string }>;
    };
    expect(matches.map((m) => m.name)).toContain('search_tools');
  });

  it('matches by name', async () => {
    const tools = buildTools(makeMockOf().of);
    const { tools: matches } = (await callTool(tools, 'search_tools', { query: '^create_' })) as {
      tools: Array<{ name: string }>;
    };
    expect(matches.map((m) => m.name).sort()).toEqual([
      'create_project',
      'create_tag',
      'create_task',
    ]);
  });

  it('matches by description text, not just name', async () => {
    const tools = buildTools(makeMockOf().of);
    const { tools: matches } = (await callTool(tools, 'search_tools', {
      query: 'perspective',
    })) as {
      tools: Array<{ name: string }>;
    };
    // get_perspective_tasks matches by name; list_perspectives matches too.
    expect(matches.map((m) => m.name)).toContain('list_perspectives');
    expect(matches.map((m) => m.name)).toContain('get_perspective_tasks');
  });

  it('returns objects with name and description', async () => {
    const tools = buildTools(makeMockOf().of);
    const { tools: matches } = (await callTool(tools, 'search_tools', {
      query: 'get_inbox_count',
    })) as {
      tools: Array<{ name: string; description: string }>;
    };
    expect(matches).toEqual([
      { name: 'get_inbox_count', description: 'Get the number of inbox tasks' },
    ]);
  });

  it('reports invalid regex through the isError envelope, not a bare success body', async () => {
    // Must honour the same isError contract SERVER_INSTRUCTIONS documents for
    // every other failure, so the model can tell the call failed.
    const tools = buildTools(makeMockOf().of);
    const result = await tool(tools, 'search_tools').handler({ query: '[' });
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.error.statusCode).toBe(400);
    expect(body.error.detail).toContain('Invalid regex pattern');
  });
});

describe('tool handlers map arguments to OmniFocus calls', () => {
  it('create_task forwards options and returns the created task', async () => {
    const { of, calls } = makeMockOf({ createTask: { id: 'x1', name: 'Buy milk' } });
    const tools = buildTools(of);
    const result = await callTool(tools, 'create_task', { name: 'Buy milk', flagged: true });
    expect(result).toEqual({ id: 'x1', name: 'Buy milk' });
    expect(calls).toContainEqual({
      method: 'createTask',
      args: [{ name: 'Buy milk', flagged: true }],
    });
  });

  it('update_task splits idOrName from the update options', async () => {
    const { of, calls } = makeMockOf({ updateTask: { id: 't1' } });
    const tools = buildTools(of);
    await callTool(tools, 'update_task', { idOrName: 't1', name: 'Renamed', flagged: false });
    expect(calls).toContainEqual({
      method: 'updateTask',
      args: ['t1', { name: 'Renamed', flagged: false }],
    });
  });

  it('delete_task calls deleteTask and returns a deleted marker', async () => {
    const { of, calls } = makeMockOf();
    const tools = buildTools(of);
    const result = await callTool(tools, 'delete_task', { idOrName: 'abc' });
    expect(result).toEqual({ deleted: true });
    expect(calls).toContainEqual({ method: 'deleteTask', args: ['abc'] });
  });

  it('get_inbox_count wraps the count in an object', async () => {
    const { of } = makeMockOf({ getInboxCount: 7 });
    const tools = buildTools(of);
    const result = await callTool(tools, 'get_inbox_count');
    expect(result).toEqual({ count: 7 });
  });

  it('get_folder passes includeDropped through as options', async () => {
    const { of, calls } = makeMockOf({ getFolder: { id: 'F', name: 'Work' } });
    const tools = buildTools(of);
    await callTool(tools, 'get_folder', { idOrName: 'Work', includeDropped: true });
    expect(calls).toContainEqual({ method: 'getFolder', args: ['Work', { includeDropped: true }] });
  });
});

describe('handler failures become isError tool results (SEP-1303)', () => {
  it('returns the structured CLI error JSON with isError, not a thrown protocol error', async () => {
    const { of } = makeMockOf({ getTask: new Error('Task not found: xyz') });
    const tools = buildTools(of);
    const result = await tool(tools, 'get_task').handler({ idOrName: 'xyz' });
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body).toEqual({
      error: { name: 'omnifocus_error', detail: 'Task not found: xyz', statusCode: 404 },
    });
  });

  it('maps unrecognised failures to a 500 error body', async () => {
    const { of } = makeMockOf({ createTask: new Error('osascript blew up') });
    const tools = buildTools(of);
    const result = await tool(tools, 'create_task').handler({ name: 'x' });
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.error.statusCode).toBe(500);
  });

  it('successful calls do not set isError', async () => {
    const { of } = makeMockOf({ getInboxCount: 3 });
    const tools = buildTools(of);
    const result = await tool(tools, 'get_inbox_count').handler({});
    expect(result.isError).toBeUndefined();
  });

  it('re-throws McpError so the SDK protocol path (e.g. elicitation) still works', async () => {
    // McpError is the SDK's protocol-level signal; the SDK dispatcher
    // special-cases it (createToolError skips it for UrlElicitationRequired).
    // safeHandler must not swallow it into an isError result.
    const { of } = makeMockOf({ getTask: new McpError(ErrorCode.InvalidRequest, 'protocol boom') });
    const tools = buildTools(of);
    await expect(tool(tools, 'get_task').handler({ idOrName: 'x' })).rejects.toBeInstanceOf(
      McpError
    );
  });
});

describe('get_perspective_tasks cancellation and progress', () => {
  it('forwards the request AbortSignal to OmniFocus', async () => {
    const { of, calls } = makeMockOf({ getPerspectiveTasks: [] });
    const tools = buildTools(of);
    const controller = new AbortController();
    await tool(tools, 'get_perspective_tasks').handler(
      { name: 'Today' },
      { signal: controller.signal }
    );
    const call = calls.find((c) => c.method === 'getPerspectiveTasks');
    expect(call?.args).toEqual(['Today', { signal: controller.signal }]);
  });

  it('emits a progress notification when the client sent a progressToken', async () => {
    const { of } = makeMockOf({ getPerspectiveTasks: [] });
    const tools = buildTools(of);
    const notifications: unknown[] = [];
    const extra: ToolCallExtra = {
      _meta: { progressToken: 42 },
      sendNotification: async (n) => {
        notifications.push(n);
      },
    };
    await tool(tools, 'get_perspective_tasks').handler({ name: 'Today' }, extra);
    expect(notifications.length).toBeGreaterThanOrEqual(1);
    expect(notifications[0]).toMatchObject({
      method: 'notifications/progress',
      params: { progressToken: 42, progress: 1 },
    });
  });

  it('sends no progress when the client did not send a token', async () => {
    const { of } = makeMockOf({ getPerspectiveTasks: [] });
    const tools = buildTools(of);
    const notifications: unknown[] = [];
    const extra: ToolCallExtra = {
      sendNotification: async (n) => {
        notifications.push(n);
      },
    };
    await tool(tools, 'get_perspective_tasks').handler({ name: 'Today' }, extra);
    expect(notifications).toHaveLength(0);
  });
});

describe('startProgressHeartbeat', () => {
  it('is a no-op without extra and stop() is safe to call', () => {
    const stop = startProgressHeartbeat(undefined, 'working');
    expect(() => stop()).not.toThrow();
  });

  it('keeps ticking on an interval until stopped', async () => {
    const notifications: unknown[] = [];
    const extra: ToolCallExtra = {
      _meta: { progressToken: 'tok' },
      sendNotification: async (n) => {
        notifications.push(n);
      },
    };
    const stop = startProgressHeartbeat(extra, 'working', 20);
    await new Promise((r) => setTimeout(r, 70));
    stop();
    const countWhenStopped = notifications.length;
    expect(countWhenStopped).toBeGreaterThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 50));
    expect(notifications.length).toBe(countWhenStopped);
  });
});

describe('server instructions', () => {
  it('document the conventions the model needs', () => {
    expect(SERVER_INSTRUCTIONS).toContain('idOrName');
    expect(SERVER_INSTRUCTIONS).toContain('ISO 8601');
    expect(SERVER_INSTRUCTIONS).toContain('get_perspective_tasks');
    expect(SERVER_INSTRUCTIONS).toContain('search_tools');
  });
});
