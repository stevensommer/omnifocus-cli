import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from '@modelcontextprotocol/ext-apps/server';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { classifyError, OmniFocusCliError } from '../lib/errors.js';
import type { OmniFocus } from '../lib/omnifocus.js';
import type { Task } from '../types.js';
import { STATS_DASHBOARD_HTML } from './apps/stats-dashboard.js';
import { TRIAGE_HTML } from './apps/triage.js';

/** URI linking the get_stats_dashboard tool to its UI template. */
export const STATS_DASHBOARD_URI = 'ui://omnifocus/stats-dashboard.html';

/** URI linking the triage_tasks tool to its UI template. */
export const TRIAGE_URI = 'ui://omnifocus/triage.html';

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

/** The single source of truth for app tools search_tools should also match. */
export const APP_TOOL_DESCRIPTORS: readonly AppToolDescriptor[] = [
  { name: 'get_stats_dashboard', description: GET_STATS_DASHBOARD_DESCRIPTION },
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
export function registerApps(server: McpServer, of: OmniFocus): void {
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

  registerAppTool(
    server,
    'get_stats_dashboard',
    {
      title: 'Stats dashboard',
      description: GET_STATS_DASHBOARD_DESCRIPTION,
      inputSchema: {},
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
        return {
          content: [{ type: 'text', text: JSON.stringify(combined, null, 2) }],
          structuredContent: combined,
        };
      } catch (error) {
        // Same isError shape as the def() wrapper in server.ts (SEP-1303).
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: classifyError(error) }, null, 2) },
          ],
          isError: true,
        };
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

  registerAppTool(
    server,
    'triage_tasks',
    {
      title: 'Triage tasks',
      description:
        'List tasks for triage by filter (inbox, actionable, flagged, or search). In MCP Apps hosts this renders an interactive triage list whose row actions (complete, flag, defer) call update_task; elsewhere it returns the task list JSON.',
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
            if (!query) {
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
        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        };
      } catch (error) {
        // Same isError shape as the def() wrapper in server.ts (SEP-1303).
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: classifyError(error) }, null, 2) },
          ],
          isError: true,
        };
      }
    }
  );
}
