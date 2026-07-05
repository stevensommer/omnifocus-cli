import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from '@modelcontextprotocol/ext-apps/server';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { classifyError } from '../lib/errors.js';
import type { OmniFocus } from '../lib/omnifocus.js';
import { STATS_DASHBOARD_HTML } from './apps/stats-dashboard.js';

/** URI linking the get_stats_dashboard tool to its UI template. */
export const STATS_DASHBOARD_URI = 'ui://omnifocus/stats-dashboard.html';

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
 * Hosts without MCP Apps support degrade gracefully: get_stats_dashboard is
 * an ordinary tool whose text content is the pretty-printed combined stats
 * JSON; only Apps-capable hosts additionally render the dashboard iframe.
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
}
