import type {
  CallToolResult,
  Icon,
  McpServer,
  ReadResourceCallback,
  RegisteredResource,
  RegisteredTool,
  ResourceMetadata,
  ServerContext,
  StandardSchemaWithJSON,
  ToolAnnotations,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { OmniFocusCliError } from '../lib/errors.js';
import type { OmniFocus } from '../lib/omnifocus.js';
import type { Task } from '../types.js';
import { StatsDashboardSchema, TriageResultSchema } from './schemas.js';
import { structuredError, structuredResponse } from './server.js';
import { STATS_DASHBOARD_HTML } from './apps/stats-dashboard.js';
import { TRIAGE_HTML } from './apps/triage.js';

/** URI linking the get_stats_dashboard tool to its UI template. */
export const STATS_DASHBOARD_URI = 'ui://omnifocus/stats-dashboard.html';

/** URI linking the triage_tasks tool to its UI template. */
export const TRIAGE_URI = 'ui://omnifocus/triage.html';

/**
 * The following three helpers (RESOURCE_MIME_TYPE, registerAppResource,
 * registerAppTool) reimplement `@modelcontextprotocol/ext-apps`'s server
 * helpers locally. That package has no v2-compatible release — it imported
 * from v1-only internal subpaths of `@modelcontextprotocol/sdk`, which has
 * itself been replaced by `@modelcontextprotocol/server` — and has no
 * successor package, so it was uninstalled. All three were thin wrappers
 * around the SDK's own McpServer methods; hand-rolling them here against v2
 * primitives keeps this file self-sufficient without reintroducing a
 * dependency on an abandoned package.
 */

/** MIME type for MCP Apps HTML resources (io.modelcontextprotocol/ui, spec 2026-01-26). */
export const RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';

/** Forwards to McpServer#registerResource for a static (string-URI) resource. */
function registerAppResource(
  server: McpServer,
  name: string,
  uri: string,
  config: ResourceMetadata,
  readCallback: ReadResourceCallback
): RegisteredResource {
  return server.registerResource(name, uri, config, readCallback);
}

/**
 * Forwards to McpServer#registerTool, additionally mirroring the UI resource
 * URI from `_meta.ui.resourceUri` into the flat legacy `_meta['ui/resourceUri']`
 * key so hosts that predate the nested `ui` meta shape can still find it.
 */
function registerAppTool<Args extends Record<string, z.ZodType>>(
  server: McpServer,
  name: string,
  config: {
    title?: string;
    description?: string;
    inputSchema?: Args;
    outputSchema?: Record<string, z.ZodType> | StandardSchemaWithJSON;
    annotations?: ToolAnnotations;
    icons?: Icon[];
    _meta: { ui: { resourceUri: string } };
  },
  cb: (args: z.infer<z.ZodObject<Args>>, ctx: ServerContext) => Promise<CallToolResult>
): RegisteredTool {
  const { _meta, ...rest } = config;
  // registerTool's raw-shape overload types its callback via a conditional
  // type keyed to a concrete Args, which TS can't resolve while Args is
  // still this wrapper's own generic parameter. The cast is safe: `cb`'s
  // args/return types are structurally identical to what that overload
  // expects once Args is instantiated at each call site below.
  return server.registerTool(
    name,
    {
      ...rest,
      _meta: {
        ..._meta,
        'ui/resourceUri': _meta.ui.resourceUri,
      },
    },
    cb as never
  );
}

/**
 * A discoverable app tool: name + description only. App tools are registered
 * directly on the server (via registerAppTool) rather than through
 * buildTools(), so search_tools would otherwise never surface them. Exporting
 * their {name, description} here — and consuming the same constant both when
 * registering (below) and inside search_tools — keeps the app surface
 * discoverable without duplicating metadata or letting the two drift.
 */
export interface AppToolDescriptor {
  name: string;
  description: string;
}

const GET_STATS_DASHBOARD_DESCRIPTION =
  'Get combined task, project, and tag statistics in one call. In MCP Apps hosts this renders an interactive dashboard; elsewhere it returns the combined JSON.';

const TRIAGE_TASKS_DESCRIPTION =
  'List tasks for triage by filter (inbox, actionable, flagged, or search). In MCP Apps hosts this renders an interactive triage list whose row actions (complete, flag, defer) call update_task; elsewhere it returns the task list JSON.';

/** The single source of truth for app tools search_tools should also match. */
export const APP_TOOL_DESCRIPTORS: readonly AppToolDescriptor[] = [
  { name: 'get_stats_dashboard', description: GET_STATS_DASHBOARD_DESCRIPTION },
  { name: 'triage_tasks', description: TRIAGE_TASKS_DESCRIPTION },
];

/**
 * Register MCP Apps (spec 2026-01-26, extension io.modelcontextprotocol/ui):
 * a ui:// HTML resource plus the app-linked tools that feed it. Kept separate
 * from the buildTools() catalogue in server.ts so the plain tool list and the
 * app surface can evolve independently.
 *
 * Hosts without MCP Apps support degrade gracefully: get_stats_dashboard and
 * triage_tasks are ordinary tools whose text content is pretty-printed JSON;
 * only Apps-capable hosts additionally render the app iframes.
 *
 * triage_tasks itself is read-only (READ annotations): the triage widget
 * performs mutations by calling the existing update_task tool back through
 * the host via app -> host "tools/call" requests.
 */
export function registerApps(server: McpServer, of: OmniFocus): RegisteredTool[] {
  registerAppResource(
    server,
    'Stats dashboard',
    STATS_DASHBOARD_URI,
    {
      description:
        'Interactive OmniFocus statistics dashboard rendered for the get_stats_dashboard tool',
      mimeType: RESOURCE_MIME_TYPE,
    },
    async () => ({
      contents: [
        {
          uri: STATS_DASHBOARD_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: STATS_DASHBOARD_HTML,
        },
      ],
    })
  );

  const statsDashboardTool = registerAppTool(
    server,
    'get_stats_dashboard',
    {
      title: 'Stats dashboard',
      description: GET_STATS_DASHBOARD_DESCRIPTION,
      inputSchema: {},
      // Full ZodObject rather than its raw shape: zod v4 objects satisfy
      // StandardSchemaWithJSON directly (both the validate and jsonSchema
      // halves), so registerAppTool's OutputArgs takes it as-is.
      outputSchema: StatsDashboardSchema,
      // Mirrors the READ preset in server.ts (title duplicated into
      // annotations for clients that predate the top-level title field).
      annotations: {
        title: 'Stats dashboard',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { ui: { resourceUri: STATS_DASHBOARD_URI } },
    },
    async (): Promise<CallToolResult> => {
      try {
        // One combined push: the app iframe receives a single tool result, so
        // all three stats payloads must arrive together.
        const [tasks, projects, tags] = await Promise.all([
          of.getTaskStats(),
          of.getProjectStats(),
          of.getTagStats(),
        ]);
        const combined = { tasks, projects, tags };
        // Object root, so structuredResponse passes it through unwrapped —
        // exactly the { content, structuredContent } shape registerAppTool wants.
        return structuredResponse(combined);
      } catch (error) {
        return structuredError(error);
      }
    }
  );

  registerAppResource(
    server,
    'Triage list',
    TRIAGE_URI,
    {
      description: 'Interactive OmniFocus triage list rendered for the triage_tasks tool',
      mimeType: RESOURCE_MIME_TYPE,
    },
    async () => ({
      contents: [
        {
          uri: TRIAGE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: TRIAGE_HTML,
        },
      ],
    })
  );

  const triageTasksTool = registerAppTool(
    server,
    'triage_tasks',
    {
      title: 'Triage tasks',
      description: TRIAGE_TASKS_DESCRIPTION,
      inputSchema: {
        filter: z
          .enum(['inbox', 'actionable', 'flagged', 'search'])
          .optional()
          .describe('Which tasks to triage (default "inbox")'),
        query: z.string().optional().describe('Search text (required when filter is "search")'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Maximum number of tasks to return (default 50)'),
      },
      // Full ZodObject, for the same reason as get_stats_dashboard above.
      outputSchema: TriageResultSchema,
      // Mirrors the READ preset in server.ts: this tool only reads; the
      // widget's mutations go through the existing update_task tool.
      annotations: {
        title: 'Triage tasks',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { ui: { resourceUri: TRIAGE_URI } },
    },
    async ({ filter = 'inbox', query, limit = 50 }): Promise<CallToolResult> => {
      try {
        let tasks: Task[];
        switch (filter) {
          case 'actionable':
            tasks = await of.listTasks({ status: 'actionable' });
            break;
          case 'flagged':
            tasks = await of.listTasks({ flagged: true });
            break;
          case 'search':
            if (!query || !query.trim()) {
              throw new OmniFocusCliError('filter "search" requires a query', 400);
            }
            tasks = await of.searchTasks(query);
            break;
          default:
            tasks = await of.listInboxTasks();
            break;
        }
        const shownTasks = tasks.slice(0, limit);
        const payload = {
          filter,
          total: tasks.length,
          shown: shownTasks.length,
          tasks: shownTasks,
        };
        // Object root, so structuredResponse passes it through unwrapped.
        return structuredResponse(payload);
      } catch (error) {
        return structuredError(error);
      }
    }
  );

  return [statsDashboardTool, triageTasksTool];
}
