import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z, type ZodRawShape } from 'zod';
import { classifyError, OmniFocusCliError } from '../lib/errors.js';
import { OmniFocus } from '../lib/omnifocus.js';
import { registerApps } from './apps.js';

/**
 * A single MCP tool definition. `buildTools()` returns these as the one source
 * of truth: they are both what gets registered on the server and what
 * `search_tools` searches over, so the searchable catalogue can never drift
 * from the registered catalogue.
 */
/**
 * Structural subset of the SDK's RequestHandlerExtra that handlers use:
 * enough for cancellation and progress without importing the SDK's generic
 * types into every test.
 */
export interface ToolCallExtra {
  signal?: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: {
    method: 'notifications/progress';
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => Promise<void>;
}

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  annotations: ToolAnnotations;
  schema: ZodRawShape;
  handler: (
    args: Record<string, unknown>,
    extra?: ToolCallExtra
  ) => CallToolResult | Promise<CallToolResult>;
}

/**
 * Annotation presets. MCP clients (Claude Desktop's connector UI in
 * particular) group tools by these hints — read-only vs write vs destructive —
 * and tools without annotations all land in an undifferentiated "Other tools"
 * bucket. Every tool must use one of these presets. `openWorldHint` is false
 * throughout: everything operates on the local OmniFocus database.
 */
const READ: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const CREATE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const UPDATE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};
// Deletes are not idempotent: lookups accept a name, so a repeated call can
// match (and delete) a different item of the same name.
const DELETE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

function jsonResponse(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/**
 * Send periodic notifications/progress while a slow tool call runs, so
 * clients that attach a progressToken (Claude Code does; Claude Desktop
 * doesn't yet) can show liveness and reset idle timeouts. No token or no
 * notification channel → no-op. Returns a stop function for finally blocks.
 */
export function startProgressHeartbeat(
  extra: ToolCallExtra | undefined,
  message: string,
  intervalMs = 5000
): () => void {
  const progressToken = extra?._meta?.progressToken;
  const send = extra?.sendNotification;
  if (progressToken === undefined || !send) return () => {};

  let progress = 0;
  const tick = () => {
    progress += 1;
    // Progress failures must never break the tool call itself.
    send({
      method: 'notifications/progress',
      params: { progressToken, progress, message },
    }).catch(() => {});
  };
  tick();
  const interval = setInterval(tick, intervalMs);
  return () => clearInterval(interval);
}

/**
 * Define a tool while preserving per-tool argument inference: the `handler`
 * sees arguments typed from its own `schema`, even though the returned specs
 * are collected into a single heterogeneous array.
 */
function def<S extends ZodRawShape>(
  name: string,
  title: string,
  description: string,
  annotations: ToolAnnotations,
  schema: S,
  handler: (
    args: z.infer<z.ZodObject<S>>,
    extra?: ToolCallExtra
  ) => CallToolResult | Promise<CallToolResult>
): ToolSpec {
  // Operational failures become isError tool results (per SEP-1303) carrying
  // the same structured error JSON as the CLI, so the calling model can read
  // the failure and self-correct. McpError is re-thrown untouched: it is the
  // SDK's protocol-level signal (e.g. elicitation-required) and the SDK's own
  // dispatcher special-cases it — wrapping it here would break that path.
  const safeHandler: ToolSpec['handler'] = async (args, extra) => {
    try {
      return await handler(args as z.infer<z.ZodObject<S>>, extra);
    } catch (error) {
      if (error instanceof McpError) throw error;
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: classifyError(error) }, null, 2) }],
        isError: true,
      };
    }
  };
  return { name, title, description, annotations, schema, handler: safeHandler };
}

/**
 * Build the full tool catalogue bound to a given OmniFocus instance. Exported
 * so tests can construct the catalogue with a mock OmniFocus and exercise the
 * handlers without needing OmniFocus or osascript.
 */
export function buildTools(of: OmniFocus): ToolSpec[] {
  const tools: ToolSpec[] = [
    def(
      'list_tasks',
      'List tasks',
      'List tasks with optional filtering',
      READ,
      {
        includeCompleted: z.boolean().optional().describe('Include completed tasks'),
        includeDropped: z.boolean().optional().describe('Include dropped tasks'),
        flagged: z.boolean().optional().describe('Only show flagged tasks'),
        project: z.string().optional().describe('Filter by project name'),
        tag: z.string().optional().describe('Filter by tag name'),
        status: z
          .enum([
            'actionable',
            'available',
            'next',
            'blocked',
            'dueSoon',
            'overdue',
            'completed',
            'dropped',
          ])
          .optional()
          .describe(
            'Filter by OmniFocus task status; "actionable" matches available|next|dueSoon|overdue (what can be worked on now)'
          ),
        dueBefore: z.string().optional().describe('Effective due date before (ISO 8601)'),
        dueAfter: z.string().optional().describe('Effective due date after (ISO 8601)'),
        deferBefore: z.string().optional().describe('Effective defer date before (ISO 8601)'),
        deferAfter: z.string().optional().describe('Effective defer date after (ISO 8601)'),
        plannedBefore: z.string().optional().describe('Planned date before (ISO 8601)'),
        plannedAfter: z.string().optional().describe('Planned date after (ISO 8601)'),
        completedBefore: z
          .string()
          .optional()
          .describe('Completed before (ISO 8601; implies includeCompleted)'),
        completedAfter: z
          .string()
          .optional()
          .describe('Completed after (ISO 8601; implies includeCompleted)'),
        addedBefore: z.string().optional().describe('Created before (ISO 8601)'),
        addedAfter: z.string().optional().describe('Created after (ISO 8601)'),
      },
      async (filters) => jsonResponse(await of.listTasks(filters))
    ),
    def(
      'get_task',
      'Get task',
      'Get a specific task by ID or name',
      READ,
      { idOrName: z.string().describe('Task ID or name') },
      async ({ idOrName }) => jsonResponse(await of.getTask(idOrName))
    ),
    def(
      'create_task',
      'Create task',
      'Create a new task',
      CREATE,
      {
        name: z.string().describe('Task name'),
        note: z.string().optional().describe('Task note'),
        project: z.string().optional().describe('Project to add task to'),
        tags: z.array(z.string()).optional().describe('Tags to assign'),
        defer: z.string().optional().describe('Defer date (ISO 8601)'),
        due: z.string().optional().describe('Due date (ISO 8601)'),
        planned: z.string().optional().describe('Planned date (ISO 8601)'),
        flagged: z.boolean().optional().describe('Flag the task'),
        estimatedMinutes: z.number().optional().describe('Estimated duration in minutes'),
      },
      async (options) => jsonResponse(await of.createTask(options))
    ),
    def(
      'update_task',
      'Update task',
      'Update an existing task',
      UPDATE,
      {
        idOrName: z.string().describe('Task ID or name'),
        name: z.string().optional().describe('New task name'),
        note: z.string().optional().describe('New task note'),
        project: z.string().optional().describe('Move to project'),
        tags: z.array(z.string()).optional().describe('Replace tags'),
        defer: z.string().optional().describe('New defer date (ISO 8601)'),
        due: z.string().optional().describe('New due date (ISO 8601)'),
        planned: z.string().optional().describe('New planned date (ISO 8601)'),
        flagged: z.boolean().optional().describe('Flag/unflag the task'),
        estimatedMinutes: z.number().optional().describe('New estimated duration'),
        completed: z.boolean().optional().describe('Mark complete/incomplete'),
      },
      async ({ idOrName, ...options }) => jsonResponse(await of.updateTask(idOrName, options))
    ),
    def(
      'drop_task',
      'Drop task',
      'Drop a task: abandon it while keeping its history (GTD-style, unlike delete)',
      UPDATE,
      {
        idOrName: z.string().describe('Task ID or name'),
        allOccurrences: z
          .boolean()
          .optional()
          .describe('Also stop future repeats of a repeating task (default false)'),
      },
      async ({ idOrName, allOccurrences }) =>
        jsonResponse(await of.dropTask(idOrName, { allOccurrences }))
    ),
    def(
      'delete_task',
      'Delete task',
      'Delete a task',
      DELETE,
      { idOrName: z.string().describe('Task ID or name') },
      async ({ idOrName }) => {
        await of.deleteTask(idOrName);
        return jsonResponse({ deleted: true });
      }
    ),
    def(
      'update_tasks',
      'Update many tasks',
      'Apply the same updates to many tasks in a single OmniFocus round trip. Returns a per-id result array {id, ok, task?, error?}; an unresolved id records an error entry instead of failing the batch. The shift*Days options add N days (negative to pull earlier) to the existing date on each task, skipping tasks without that date.',
      UPDATE,
      {
        ids: z.array(z.string()).describe('Task IDs or exact names to update'),
        name: z.string().optional().describe('New task name (applied to every task)'),
        note: z.string().optional().describe('New task note'),
        project: z.string().optional().describe('Move to project'),
        tags: z.array(z.string()).optional().describe('Replace tags'),
        defer: z.string().optional().describe('New defer date (ISO 8601)'),
        due: z.string().optional().describe('New due date (ISO 8601)'),
        planned: z.string().optional().describe('New planned date (ISO 8601)'),
        flagged: z.boolean().optional().describe('Flag/unflag the tasks'),
        estimatedMinutes: z.number().optional().describe('New estimated duration'),
        completed: z.boolean().optional().describe('Mark complete/incomplete'),
        shiftDueDays: z
          .number()
          .int()
          .optional()
          .describe('Shift the due date of each task by N days (may be negative)'),
        shiftDeferDays: z
          .number()
          .int()
          .optional()
          .describe('Shift the defer date of each task by N days (may be negative)'),
        shiftPlannedDays: z
          .number()
          .int()
          .optional()
          .describe('Shift the planned date of each task by N days (may be negative)'),
      },
      async ({ ids, ...options }) => jsonResponse(await of.updateTasks(ids, options))
    ),
    def(
      'convert_task_to_project',
      'Convert task to project',
      'Convert a task into a new project (child tasks come along). The project lands in the given folder, or at the end of the library.',
      UPDATE,
      {
        idOrName: z.string().describe('Task ID or name'),
        folder: z.string().optional().describe('Destination folder ID or name'),
      },
      async ({ idOrName, folder }) =>
        jsonResponse(await of.convertTaskToProject(idOrName, { folder }))
    ),
    def(
      'search_tasks',
      'Search tasks',
      'Search tasks by name or note content',
      READ,
      { query: z.string().describe('Search query') },
      async ({ query }) => jsonResponse(await of.searchTasks(query))
    ),
    def('get_task_stats', 'Get task statistics', 'Get task statistics', READ, {}, async () =>
      jsonResponse(await of.getTaskStats())
    ),
    def('list_inbox', 'List inbox tasks', 'List all inbox tasks', READ, {}, async () =>
      jsonResponse(await of.listInboxTasks())
    ),
    def('get_inbox_count', 'Get inbox count', 'Get the number of inbox tasks', READ, {}, async () =>
      jsonResponse({ count: await of.getInboxCount() })
    ),
    def(
      'cleanup_inbox',
      'Clean up inbox',
      'Process the inbox: optionally assign unassigned inbox tasks a default project, then run OmniFocus cleanup to file them. Returns {inboxBefore, assigned, inboxAfter}.',
      UPDATE,
      {
        container: z
          .string()
          .optional()
          .describe('Project ID or name to assign unassigned inbox tasks to before cleanup'),
      },
      async ({ container }) => jsonResponse(await of.cleanupInbox({ container }))
    ),
    def(
      'list_projects',
      'List projects',
      'List projects with optional filtering',
      READ,
      {
        includeDropped: z.boolean().optional().describe('Include dropped projects'),
        status: z.enum(['active', 'on hold', 'dropped']).optional().describe('Filter by status'),
        folder: z.string().optional().describe('Filter by folder name'),
      },
      async (filters) => jsonResponse(await of.listProjects(filters))
    ),
    def(
      'get_project',
      'Get project',
      'Get a specific project by ID or name',
      READ,
      { idOrName: z.string().describe('Project ID or name') },
      async ({ idOrName }) => jsonResponse(await of.getProject(idOrName))
    ),
    def(
      'create_project',
      'Create project',
      'Create a new project',
      CREATE,
      {
        name: z.string().describe('Project name'),
        note: z.string().optional().describe('Project note'),
        folder: z.string().optional().describe('Folder to create project in'),
        sequential: z
          .boolean()
          .optional()
          .describe('Sequential project (tasks must be done in order)'),
        tags: z.array(z.string()).optional().describe('Tags to assign'),
        status: z.enum(['active', 'on hold', 'dropped']).optional().describe('Initial status'),
        reviewInterval: z
          .string()
          .optional()
          .describe('Review interval, e.g. "1 week" or "2 months"'),
      },
      async (options) => jsonResponse(await of.createProject(options))
    ),
    def(
      'update_project',
      'Update project',
      'Update an existing project',
      UPDATE,
      {
        idOrName: z.string().describe('Project ID or name'),
        name: z.string().optional().describe('New project name'),
        note: z.string().optional().describe('New project note'),
        folder: z.string().optional().describe('Move to folder'),
        sequential: z.boolean().optional().describe('Set sequential/parallel'),
        tags: z.array(z.string()).optional().describe('Replace tags'),
        status: z.enum(['active', 'on hold', 'dropped']).optional().describe('New status'),
        reviewInterval: z
          .string()
          .optional()
          .describe('Review interval, e.g. "1 week" or "2 months"'),
      },
      async ({ idOrName, ...options }) => jsonResponse(await of.updateProject(idOrName, options))
    ),
    def(
      'complete_project',
      'Complete project',
      'Mark a project complete (or incomplete). Uses markComplete, which correctly handles repeating projects.',
      UPDATE,
      {
        idOrName: z.string().describe('Project ID or name'),
        date: z.string().optional().describe('Completion date (ISO 8601, defaults to now)'),
        incomplete: z.boolean().optional().describe('Mark the project incomplete instead'),
      },
      async ({ idOrName, date, incomplete }) =>
        jsonResponse(await of.completeProject(idOrName, { date, incomplete }))
    ),
    def(
      'list_projects_due_for_review',
      'List projects due for review',
      'List projects whose next review date has passed (headless; excludes dropped and completed projects)',
      READ,
      {},
      async () => jsonResponse(await of.listProjectsDueForReview())
    ),
    def(
      'mark_project_reviewed',
      'Mark project reviewed',
      'Mark a project as reviewed now; OmniFocus reschedules its next review from the review interval',
      UPDATE,
      { idOrName: z.string().describe('Project ID or name') },
      async ({ idOrName }) => jsonResponse(await of.markProjectReviewed(idOrName))
    ),
    def(
      'search_projects',
      'Search projects',
      'Fuzzy-search projects using OmniFocus Quick Open matching',
      READ,
      { query: z.string().describe('Search query') },
      async ({ query }) => jsonResponse(await of.searchProjects(query))
    ),
    def(
      'delete_project',
      'Delete project',
      'Delete a project',
      DELETE,
      { idOrName: z.string().describe('Project ID or name') },
      async ({ idOrName }) => {
        await of.deleteProject(idOrName);
        return jsonResponse({ deleted: true });
      }
    ),
    def(
      'get_project_stats',
      'Get project statistics',
      'Get project statistics',
      READ,
      {},
      async () => jsonResponse(await of.getProjectStats())
    ),
    def(
      'list_perspectives',
      'List perspectives',
      'List all available perspectives',
      READ,
      {},
      async () => jsonResponse(await of.listPerspectives())
    ),
    // Read-only for OmniFocus data, though it does switch the frontmost
    // window's perspective as a side effect of traversing the content tree.
    def(
      'get_perspective_tasks',
      'Get perspective tasks',
      'Get tasks from a specific perspective',
      READ,
      {
        name: z.string().describe('Perspective name (e.g., Inbox, Flagged, or custom perspective)'),
      },
      async ({ name }, extra) => {
        // Perspective traversal can run up to 60s: emit progress heartbeats
        // (when the client sent a token) and abort osascript on cancellation.
        const stopHeartbeat = startProgressHeartbeat(
          extra,
          `Reading perspective "${name}" in OmniFocus`
        );
        try {
          return jsonResponse(await of.getPerspectiveTasks(name, { signal: extra?.signal }));
        } finally {
          stopHeartbeat();
        }
      }
    ),
    def(
      'list_tags',
      'List tags',
      'List all tags with optional filtering and sorting',
      READ,
      {
        unusedDays: z.number().optional().describe('Only show tags unused for this many days'),
        sortBy: z.enum(['name', 'usage', 'activity']).optional().describe('Sort order'),
        activeOnly: z.boolean().optional().describe('Only count active tasks'),
      },
      async (options) => jsonResponse(await of.listTags(options))
    ),
    def(
      'get_tag',
      'Get tag',
      'Get a specific tag by ID or name',
      READ,
      { idOrName: z.string().describe('Tag ID, name, or path (e.g., "Parent/Child")') },
      async ({ idOrName }) => jsonResponse(await of.getTag(idOrName))
    ),
    def(
      'create_tag',
      'Create tag',
      'Create a new tag',
      CREATE,
      {
        name: z.string().describe('Tag name'),
        parent: z.string().optional().describe('Parent tag name or path'),
        status: z.enum(['active', 'on hold', 'dropped']).optional().describe('Initial status'),
      },
      async (options) => jsonResponse(await of.createTag(options))
    ),
    def(
      'update_tag',
      'Update tag',
      'Update an existing tag',
      UPDATE,
      {
        idOrName: z.string().describe('Tag ID, name, or path'),
        name: z.string().optional().describe('New tag name'),
        status: z.enum(['active', 'on hold', 'dropped']).optional().describe('New status'),
      },
      async ({ idOrName, ...options }) => jsonResponse(await of.updateTag(idOrName, options))
    ),
    def(
      'delete_tag',
      'Delete tag',
      'Delete a tag',
      DELETE,
      { idOrName: z.string().describe('Tag ID, name, or path') },
      async ({ idOrName }) => {
        await of.deleteTag(idOrName);
        return jsonResponse({ deleted: true });
      }
    ),
    def('get_tag_stats', 'Get tag statistics', 'Get tag statistics', READ, {}, async () =>
      jsonResponse(await of.getTagStats())
    ),
    def(
      'search_tags',
      'Search tags',
      'Fuzzy-search tags using OmniFocus Quick Open matching',
      READ,
      { query: z.string().describe('Search query') },
      async ({ query }) => jsonResponse(await of.searchTags(query))
    ),
    def(
      'list_folders',
      'List folders',
      'List all folders',
      READ,
      { includeDropped: z.boolean().optional().describe('Include dropped folders') },
      async (filters) => jsonResponse(await of.listFolders(filters))
    ),
    def(
      'get_folder',
      'Get folder',
      'Get a specific folder by ID or name',
      READ,
      {
        idOrName: z.string().describe('Folder ID or name'),
        includeDropped: z.boolean().optional().describe('Include dropped children'),
      },
      async ({ idOrName, includeDropped }) =>
        jsonResponse(await of.getFolder(idOrName, { includeDropped }))
    ),
    def(
      'create_folder',
      'Create folder',
      'Create a new folder, optionally inside a parent folder',
      CREATE,
      {
        name: z.string().describe('Folder name'),
        parent: z.string().optional().describe('Parent folder ID or name'),
      },
      async (options) => jsonResponse(await of.createFolder(options))
    ),
    def(
      'update_folder',
      'Update folder',
      'Update an existing folder: rename, set status, or move into another folder',
      UPDATE,
      {
        idOrName: z.string().describe('Folder ID or name'),
        name: z.string().optional().describe('New folder name'),
        status: z.enum(['active', 'dropped']).optional().describe('New status'),
        parent: z.string().optional().describe('Move into this parent folder'),
      },
      async ({ idOrName, ...options }) => jsonResponse(await of.updateFolder(idOrName, options))
    ),
    def(
      'delete_folder',
      'Delete folder',
      'Delete a folder',
      DELETE,
      { idOrName: z.string().describe('Folder ID or name') },
      async ({ idOrName }) => {
        await of.deleteFolder(idOrName);
        return jsonResponse({ deleted: true });
      }
    ),
    def(
      'search_folders',
      'Search folders',
      'Fuzzy-search folders using OmniFocus Quick Open matching',
      READ,
      { query: z.string().describe('Search query') },
      async ({ query }) => jsonResponse(await of.searchFolders(query))
    ),
    def(
      'undo',
      'Undo last change',
      'Undo the last change in the OmniFocus database. Errors when there is nothing to undo. Undo granularity is OmniFocus action grouping: one tool call is typically one undo group.',
      UPDATE,
      {},
      async () => jsonResponse(await of.undo())
    ),
    def(
      'redo',
      'Redo last undone change',
      'Redo the last undone change in the OmniFocus database. Errors when there is nothing to redo.',
      UPDATE,
      {},
      async () => jsonResponse(await of.redo())
    ),
    def(
      'sync_now',
      'Sync now',
      'Save the OmniFocus database, which triggers a sync when sync is enabled',
      CREATE,
      {},
      async () => jsonResponse(await of.syncNow())
    ),
  ];

  // search_tools searches over the full catalogue, including itself, so what an
  // agent can discover is exactly what is registered.
  tools.push(
    def(
      'search_tools',
      'Search tools',
      'Search for available tools by name or description using regex. Returns matching tool names.',
      READ,
      {
        query: z
          .string()
          .describe(
            'Regex pattern to match against tool names and descriptions (case-insensitive)'
          ),
      },
      async ({ query }) => {
        let pattern: RegExp;
        try {
          pattern = new RegExp(query, 'i');
        } catch {
          // Route through the shared error envelope so this failure honours the
          // documented isError contract like every other tool, letting the
          // model see it failed and retry with a valid pattern.
          throw new OmniFocusCliError(`Invalid regex pattern: ${query}`, 400);
        }
        const matches = tools
          .filter((t) => pattern.test(t.name) || pattern.test(t.description))
          .map((t) => ({ name: t.name, description: t.description }));
        return jsonResponse({ tools: matches });
      }
    )
  );

  return tools;
}

/**
 * The server version reported at initialize. tsup injects __VERSION__ at build
 * time for the shipped binary; when running from source (vitest/bun, or any
 * non-cli entry point where the define never ran) fall back to reading
 * package.json rather than advertising a bogus sentinel for capability gating
 * or telemetry. The '0.0.0-dev' sentinel remains only as a last resort if the
 * package.json read itself fails.
 */
function resolveVersion(): string {
  if (typeof __VERSION__ !== 'undefined') return __VERSION__;
  try {
    const pkgUrl = new URL('../../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0-dev';
  } catch {
    return '0.0.0-dev';
  }
}

const VERSION = resolveVersion();

/**
 * Sent to clients at initialize and injected into the model's context.
 * Conventions that otherwise live only in README/CLAUDE.md belong here —
 * this is the one place the calling model is guaranteed to see them.
 */
export const SERVER_INSTRUCTIONS = `CLI-backed MCP server for OmniFocus on macOS. OmniFocus must be installed and running; the first call may trigger a macOS Automation permission prompt.

- Tools taking "idOrName" accept a primary key ID (e.g. "kXu3B-LZfFH") or an exact name. IDs are unambiguous and preferred — get them from the list/search tools first.
- Dates are ISO 8601 strings: "YYYY-MM-DD" or a full timestamp like "2026-07-04T10:00:00". Returned dates are ISO strings.
- Tag names may be hierarchical paths like "Parent/Child".
- get_perspective_tasks requires an OmniFocus window to be open, may take up to 60 seconds, and switches the visible perspective as a side effect. Other tools are headless.
- Failed calls return a JSON body {"error": {"name", "detail", "statusCode"}} with isError set; a 404 usually means the idOrName didn't match anything.
- Prefer update_tasks over repeated update_task calls when changing several tasks: it runs in one round trip and returns per-id {id, ok, error?} results instead of failing the whole batch.
- undo/redo revert whole tool calls (OmniFocus groups each script into one undo step) — a safety valve after a bad batch update.
- Use search_tools (case-insensitive regex over tool names/descriptions) to discover capabilities.`;

export async function runMcpServer() {
  const server = new McpServer(
    {
      name: 'omnifocus',
      title: 'OmniFocus',
      version: VERSION,
      description: 'Manage OmniFocus tasks, projects, tags, folders, and perspectives on this Mac',
      websiteUrl: 'https://github.com/stephendolan/omnifocus-cli#readme',
    },
    { instructions: SERVER_INSTRUCTIONS }
  );

  const of = new OmniFocus();
  for (const tool of buildTools(of)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.schema,
        // Duplicate the title into annotations for clients that predate the
        // top-level `title` field and fall back to `annotations.title`.
        annotations: { title: tool.title, ...tool.annotations },
      },
      tool.handler
    );
  }

  registerApps(server, of);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
