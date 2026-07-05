import { z } from 'zod';

/**
 * Zod output schemas for MCP structured content (outputSchema on each tool).
 *
 * These mirror the JXA serializers in src/lib/omnifocus.ts (OMNI_HELPERS:
 * serializeTask, serializeProject, serializeTag, serializeFolder, plus the
 * inline stats/batch/cleanup shapes) field for field. The MCP SDK validates
 * every non-error structuredContent against the tool's outputSchema at
 * runtime, so a schema stricter than the serializer breaks the tool — when
 * the serializer's output is loosely typed, the schema is loosened to match
 * (e.g. reviewInterval.unit is passed through raw, so it stays a string).
 * All object roots use .passthrough() so a serializer gaining a field never
 * fails validation; only *missing* or mistyped fields fail.
 *
 * Convention for array results: CallToolResult.structuredContent must be a
 * JSON object, so list tools wrap their arrays as { items, count } via
 * listOf(). The text content block keeps the raw pretty-printed array for
 * backwards compatibility (see structuredResponse in server.ts).
 */

/** ISO 8601 date-time string (serializers emit Date.toISOString()). */
const isoDate = z.string();

/** Mirrors serializeRepetition (Task.RepetitionRule). */
export const RepetitionSchema = z
  .object({
    ruleString: z.string(),
    scheduleType: z.enum(['regularly', 'fromCompletion', 'none']),
    anchorDateKey: z.enum(['deferDate', 'dueDate', 'plannedDate']),
    catchUpAutomatically: z.boolean(),
  })
  .passthrough();

const taskShape = {
  id: z.string(),
  name: z.string(),
  note: z.string().nullable(),
  completed: z.boolean(),
  dropped: z.boolean(),
  effectivelyActive: z.boolean(),
  flagged: z.boolean(),
  effectiveFlagged: z.boolean(),
  taskStatus: z.enum([
    'available',
    'next',
    'blocked',
    'dueSoon',
    'overdue',
    'completed',
    'dropped',
  ]),
  project: z.string().nullable(),
  parentId: z.string().nullable(),
  hasChildren: z.boolean(),
  childIds: z.array(z.string()),
  sequential: z.boolean(),
  inInbox: z.boolean(),
  repetition: RepetitionSchema.nullable(),
  tags: z.array(z.string()),
  defer: isoDate.nullable(),
  due: isoDate.nullable(),
  planned: isoDate.nullable(),
  effectiveDefer: isoDate.nullable(),
  effectiveDue: isoDate.nullable(),
  estimatedMinutes: z.number().nullable(),
  completionDate: isoDate.nullable(),
  dropDate: isoDate.nullable(),
  added: isoDate.nullable(),
  modified: isoDate.nullable(),
  url: z.string(),
};

/**
 * Mirrors serializeTask. `children` (one level of serialized child tasks,
 * themselves without children) is only present via get_task includeChildren.
 */
export const TaskSchema = z
  .object({ ...taskShape, children: z.array(z.object(taskShape).passthrough()).optional() })
  .passthrough();

/** Mirrors serializeProject's reviewInterval (Project.ReviewInterval). */
export const ReviewIntervalSchema = z
  .object({
    steps: z.number(),
    // The serializer passes Omni Automation's unit string through raw.
    unit: z.string(),
  })
  .passthrough();

/** Mirrors serializeProject. */
export const ProjectSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    note: z.string().nullable(),
    status: z.enum(['active', 'on hold', 'dropped', 'done']),
    folder: z.string().nullable(),
    sequential: z.boolean(),
    flagged: z.boolean(),
    defer: isoDate.nullable(),
    due: isoDate.nullable(),
    completionDate: isoDate.nullable(),
    dropDate: isoDate.nullable(),
    estimatedMinutes: z.number().nullable(),
    completedByChildren: z.boolean(),
    containsSingletonActions: z.boolean(),
    nextTask: z.object({ id: z.string(), name: z.string() }).passthrough().nullable(),
    taskCount: z.number(),
    remainingCount: z.number(),
    tags: z.array(z.string()),
    reviewInterval: ReviewIntervalSchema.nullable(),
    lastReviewDate: isoDate.nullable(),
    nextReviewDate: isoDate.nullable(),
    repetition: RepetitionSchema.nullable(),
    url: z.string(),
  })
  .passthrough();

/** Mirrors serializeTag. */
export const TagSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    taskCount: z.number(),
    remainingTaskCount: z.number(),
    added: isoDate.nullable(),
    modified: isoDate.nullable(),
    lastActivity: isoDate.nullable(),
    active: z.boolean(),
    // Tags share statusToString(status, Tag.Status) with projects. Live probes
    // show Tag.Status has no Done member (all tags read 'active'|'on hold'|
    // 'dropped'), so 'done' is currently unreachable for tags — but the shared
    // serializer would emit it if a future OmniFocus added Tag.Status.Done, so
    // 'done' is listed defensively to keep the schema a superset of the
    // serializer's domain.
    status: z.enum(['active', 'on hold', 'dropped', 'done']),
    parent: z.string().nullable(),
    children: z.array(z.string()),
    allowsNextAction: z.boolean(),
    url: z.string(),
  })
  .passthrough();

/**
 * Mirrors serializeFolder. Folders nest arbitrarily, so `children` recurses
 * via z.lazy on the array items; the SDK's zod-to-json-schema serialises the
 * recursion as internal $ref pointers (verified against
 * @modelcontextprotocol/sdk 1.25.x). The root must stay a plain ZodObject —
 * the SDK's normalizeObjectSchema silently drops a top-level ZodLazy.
 */
export const FolderSchema: z.ZodType<Record<string, unknown>> = z
  .object({
    id: z.string(),
    name: z.string(),
    status: z.enum(['active', 'dropped']),
    effectivelyActive: z.boolean(),
    parent: z.string().nullable(),
    projectCount: z.number(),
    remainingProjectCount: z.number(),
    folderCount: z.number(),
    children: z.array(z.lazy(() => FolderSchema)),
    url: z.string(),
  })
  .passthrough();

/** Mirrors the listPerspectives script output. */
export const PerspectiveSchema = z.object({ id: z.string(), name: z.string() }).passthrough();

/** {name, taskCount} rows emitted by computeTopItems in the stats scripts. */
const nameTaskCount = z.object({ name: z.string(), taskCount: z.number() }).passthrough();

/** Mirrors the getTaskStats script output (TaskStats). */
export const TaskStatsSchema = z
  .object({
    totalTasks: z.number(),
    activeTasks: z.number(),
    completedTasks: z.number(),
    flaggedTasks: z.number(),
    overdueActiveTasks: z.number(),
    avgEstimatedMinutes: z.number().nullable(),
    tasksWithEstimates: z.number(),
    completionRate: z.number(),
    tasksByProject: z.array(nameTaskCount),
    tasksByTag: z.array(nameTaskCount),
  })
  .passthrough();

/** Mirrors the getProjectStats script output (ProjectStats). */
export const ProjectStatsSchema = z
  .object({
    totalProjects: z.number(),
    activeProjects: z.number(),
    onHoldProjects: z.number(),
    droppedProjects: z.number(),
    doneProjects: z.number(),
    sequentialProjects: z.number(),
    parallelProjects: z.number(),
    avgTasksPerProject: z.number(),
    avgRemainingPerProject: z.number(),
    avgCompletionRate: z.number(),
    projectsWithMostTasks: z.array(nameTaskCount),
    projectsWithMostRemaining: z.array(
      z.object({ name: z.string(), remainingCount: z.number() }).passthrough()
    ),
  })
  .passthrough();

/** Mirrors the getTagStats script output (TagStats). */
export const TagStatsSchema = z
  .object({
    totalTags: z.number(),
    activeTags: z.number(),
    tagsWithTasks: z.number(),
    unusedTags: z.number(),
    avgTasksPerTag: z.number(),
    mostUsedTags: z.array(nameTaskCount),
    leastUsedTags: z.array(nameTaskCount),
    staleTags: z.array(z.object({ name: z.string(), daysSinceActivity: z.number() }).passthrough()),
  })
  .passthrough();

/** Mirrors the per-id rows returned by updateTasks (BatchUpdateResult). */
export const BatchUpdateResultSchema = z
  .object({
    id: z.string(),
    ok: z.boolean(),
    task: TaskSchema.optional(),
    error: z.string().optional(),
  })
  .passthrough();

/** Mirrors the cleanupInbox script output (CleanupInboxResult). */
export const CleanupInboxResultSchema = z
  .object({ inboxBefore: z.number(), assigned: z.number(), inboxAfter: z.number() })
  .passthrough();

/** {deleted: true} marker returned by the delete_* tools. */
export const DeletedSchema = z.object({ deleted: z.boolean() }).passthrough();

/** {count} wrapper returned by get_inbox_count. */
export const CountSchema = z.object({ count: z.number() }).passthrough();

/** undo / redo / sync_now status objects. */
export const UndoneSchema = z.object({ undone: z.boolean() }).passthrough();
export const RedoneSchema = z.object({ redone: z.boolean() }).passthrough();
export const SavedSchema = z.object({ saved: z.boolean() }).passthrough();

/**
 * search_tools result: a match list on success, or {error} for an invalid
 * regex (reported in-band rather than as an isError result).
 */
export const SearchToolsResultSchema = z
  .object({
    tools: z
      .array(z.object({ name: z.string(), description: z.string() }).passthrough())
      .optional(),
    error: z.string().optional(),
  })
  .passthrough();

/**
 * Wrap an item schema as the { items, count } object that list tools put in
 * structuredContent (the MCP spec requires an object root, not an array).
 */
export function listOf(item: z.ZodTypeAny) {
  return z.object({ items: z.array(item), count: z.number().int() }).passthrough();
}

/** get_stats_dashboard combined payload. */
export const StatsDashboardSchema = z
  .object({ tasks: TaskStatsSchema, projects: ProjectStatsSchema, tags: TagStatsSchema })
  .passthrough();

/** triage_tasks payload. */
export const TriageResultSchema = z
  .object({
    filter: z.enum(['inbox', 'actionable', 'flagged', 'search']),
    total: z.number(),
    shown: z.number(),
    tasks: z.array(TaskSchema),
  })
  .passthrough();
