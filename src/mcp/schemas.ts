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
 * All object roots use .loose() so a serializer gaining a field never
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
  .loose();

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
  .object({ ...taskShape, children: z.array(z.object(taskShape).loose()).optional() })
  .loose();

/** Mirrors serializeProject's reviewInterval (Project.ReviewInterval). */
export const ReviewIntervalSchema = z
  .object({
    steps: z.number(),
    // The serializer passes Omni Automation's unit string through raw.
    unit: z.string(),
  })
  .loose();

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
    nextTask: z.object({ id: z.string(), name: z.string() }).loose().nullable(),
    taskCount: z.number(),
    remainingCount: z.number(),
    tags: z.array(z.string()),
    reviewInterval: ReviewIntervalSchema.nullable(),
    lastReviewDate: isoDate.nullable(),
    nextReviewDate: isoDate.nullable(),
    repetition: RepetitionSchema.nullable(),
    url: z.string(),
  })
  .loose();

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
  .loose();

/**
 * Mirrors serializeFolder. Folders nest arbitrarily, so `children` recurses
 * via z.lazy on the array items. Zod v4's native JSON Schema converter
 * (z.toJSONSchema) handles this self-recursion cleanly under target:
 * 'draft-2020-12', emitting a `{ "$ref": "#" }` pointer back to the schema
 * root for `children` items (verified against zod 4.4.3) — no third-party
 * converter involved.
 */
export const FolderSchema: z.ZodType = z
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
  .loose();

/** Mirrors the listPerspectives script output. */
export const PerspectiveSchema = z.object({ id: z.string(), name: z.string() }).loose();

/** {name, taskCount} rows emitted by computeTopItems in the stats scripts. */
const nameTaskCount = z.object({ name: z.string(), taskCount: z.number() }).loose();

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
  .loose();

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
      z.object({ name: z.string(), remainingCount: z.number() }).loose()
    ),
  })
  .loose();

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
    staleTags: z.array(z.object({ name: z.string(), daysSinceActivity: z.number() }).loose()),
  })
  .loose();

/** Mirrors the per-id rows returned by updateTasks (BatchUpdateResult). */
export const BatchUpdateResultSchema = z
  .object({
    id: z.string(),
    ok: z.boolean(),
    task: TaskSchema.optional(),
    error: z.string().optional(),
  })
  .loose();

/** Mirrors the cleanupInbox script output (CleanupInboxResult). */
export const CleanupInboxResultSchema = z
  .object({ inboxBefore: z.number(), assigned: z.number(), inboxAfter: z.number() })
  .loose();

/** {deleted: true} marker returned by the delete_* tools. */
export const DeletedSchema = z.object({ deleted: z.boolean() }).loose();

/** {count} wrapper returned by get_inbox_count. */
export const CountSchema = z.object({ count: z.number() }).loose();

/** undo / redo / sync_now status objects. */
export const UndoneSchema = z.object({ undone: z.boolean() }).loose();
export const RedoneSchema = z.object({ redone: z.boolean() }).loose();
export const SavedSchema = z.object({ saved: z.boolean() }).loose();

/**
 * search_tools result: a match list on success, or {error} for an invalid
 * regex (reported in-band rather than as an isError result).
 */
export const SearchToolsResultSchema = z
  .object({
    tools: z.array(z.object({ name: z.string(), description: z.string() }).loose()).optional(),
    error: z.string().optional(),
  })
  .loose();

/**
 * Wrap an item schema as the { items, count } object that list tools put in
 * structuredContent (the MCP spec requires an object root, not an array).
 */
export function listOf(item: z.ZodType) {
  return z.object({ items: z.array(item), count: z.number().int() }).loose();
}

/** get_stats_dashboard combined payload. */
export const StatsDashboardSchema = z
  .object({ tasks: TaskStatsSchema, projects: ProjectStatsSchema, tags: TagStatsSchema })
  .loose();

/** triage_tasks payload. */
export const TriageResultSchema = z
  .object({
    filter: z.enum(['inbox', 'actionable', 'flagged', 'search']),
    total: z.number(),
    shown: z.number(),
    tasks: z.array(TaskSchema),
  })
  .loose();
