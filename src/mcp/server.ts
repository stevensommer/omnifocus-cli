import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z, type ZodRawShape } from 'zod';
import { OmniFocus } from '../lib/omnifocus.js';

/**
 * A single MCP tool definition. `buildTools()` returns these as the one source
 * of truth: they are both what gets registered on the server and what
 * `search_tools` searches over, so the searchable catalogue can never drift
 * from the registered catalogue.
 */
export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  annotations: ToolAnnotations;
  schema: ZodRawShape;
  handler: (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;
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
  handler: (args: z.infer<z.ZodObject<S>>) => CallToolResult | Promise<CallToolResult>
): ToolSpec {
  return { name, title, description, annotations, schema, handler: handler as ToolSpec['handler'] };
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
      },
      async ({ idOrName, ...options }) => jsonResponse(await of.updateProject(idOrName, options))
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
      async ({ name }) => jsonResponse(await of.getPerspectiveTasks(name))
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
        try {
          const pattern = new RegExp(query, 'i');
          const matches = tools
            .filter((t) => pattern.test(t.name) || pattern.test(t.description))
            .map((t) => ({ name: t.name, description: t.description }));
          return jsonResponse({ tools: matches });
        } catch {
          return jsonResponse({ error: 'Invalid regex pattern' });
        }
      }
    )
  );

  return tools;
}

export async function runMcpServer() {
  const server = new McpServer({
    name: 'omnifocus',
    version: '1.0.0',
  });

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

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
