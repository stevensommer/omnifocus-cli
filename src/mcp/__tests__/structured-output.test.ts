import { describe, expect, it } from 'vitest';
import type { OmniFocus } from '../../lib/omnifocus.js';
import {
  FolderSchema,
  RepetitionSchema,
  StatsDashboardSchema,
  TagSchema,
  TaskSchema,
  TriageResultSchema,
} from '../schemas.js';
import { buildTools, structuredError, structuredResponse, type ToolSpec } from '../server.js';

/**
 * Drift guard between the JXA serializers and the MCP output schemas.
 *
 * The fixtures below mirror the OMNI_HELPERS serializers in
 * src/lib/omnifocus.ts (serializeTask, serializeProject, serializeTag,
 * serializeFolder, and the stats/batch/cleanup script outputs) field for
 * field. Every tool is exercised through its real handler with these
 * fixtures, and the resulting structuredContent must parse against the
 * tool's outputSchema — exactly the validation the MCP SDK performs at
 * runtime. If a serializer and its schema drift apart, this suite fails
 * before a live tool call does.
 */

// --- Fixtures (field-for-field copies of serializer output) ---

const repetitionFixture = {
  ruleString: 'FREQ=WEEKLY;BYDAY=MO',
  scheduleType: 'regularly',
  anchorDateKey: 'dueDate',
  catchUpAutomatically: false,
};

const taskFixture = {
  id: 'kXu3B-LZfFH',
  name: 'Buy milk',
  note: null,
  completed: false,
  dropped: false,
  effectivelyActive: true,
  flagged: true,
  effectiveFlagged: true,
  taskStatus: 'available',
  project: 'Errands',
  parentId: null,
  hasChildren: false,
  childIds: [],
  sequential: false,
  inInbox: false,
  repetition: repetitionFixture,
  tags: ['errands'],
  defer: '2026-07-01T00:00:00.000Z',
  due: '2026-07-08T00:00:00.000Z',
  planned: null,
  effectiveDefer: '2026-07-01T00:00:00.000Z',
  effectiveDue: '2026-07-08T00:00:00.000Z',
  estimatedMinutes: 15,
  completionDate: null,
  dropDate: null,
  added: '2026-06-30T10:00:00.000Z',
  modified: '2026-06-30T10:05:00.000Z',
  url: 'omnifocus:///task/kXu3B-LZfFH',
};

const projectFixture = {
  id: 'pRoJ-1',
  name: 'House renovation',
  note: null,
  status: 'active',
  folder: 'Home',
  sequential: false,
  flagged: false,
  defer: null,
  due: '2026-08-01T00:00:00.000Z',
  completionDate: null,
  dropDate: null,
  estimatedMinutes: null,
  completedByChildren: false,
  containsSingletonActions: false,
  nextTask: { id: 'kXu3B-LZfFH', name: 'Buy milk' },
  taskCount: 12,
  remainingCount: 5,
  tags: ['home'],
  reviewInterval: { steps: 1, unit: 'weeks' },
  lastReviewDate: '2026-06-28T09:00:00.000Z',
  nextReviewDate: '2026-07-05T09:00:00.000Z',
  repetition: null,
  url: 'omnifocus:///project/pRoJ-1',
};

const tagFixture = {
  id: 'tAg-1',
  name: 'errands',
  taskCount: 4,
  remainingTaskCount: 2,
  added: '2026-01-01T00:00:00.000Z',
  modified: '2026-06-30T10:00:00.000Z',
  lastActivity: '2026-06-30T10:00:00.000Z',
  active: true,
  status: 'active',
  parent: null,
  children: ['shops'],
  allowsNextAction: true,
  url: 'omnifocus:///tag/tAg-1',
};

const folderFixture = {
  id: 'fOlD-1',
  name: 'Home',
  status: 'active',
  effectivelyActive: true,
  parent: null,
  projectCount: 3,
  remainingProjectCount: 2,
  folderCount: 1,
  children: [
    {
      id: 'fOlD-2',
      name: 'Garden',
      status: 'active',
      effectivelyActive: true,
      parent: 'Home',
      projectCount: 1,
      remainingProjectCount: 1,
      folderCount: 0,
      children: [],
      url: 'omnifocus:///folder/fOlD-2',
    },
  ],
  url: 'omnifocus:///folder/fOlD-1',
};

const taskStatsFixture = {
  totalTasks: 100,
  activeTasks: 40,
  completedTasks: 55,
  flaggedTasks: 6,
  overdueActiveTasks: 3,
  avgEstimatedMinutes: 22,
  tasksWithEstimates: 18,
  completionRate: 58,
  tasksByProject: [{ name: 'House renovation', taskCount: 12 }],
  tasksByTag: [{ name: 'errands', taskCount: 4 }],
};

const projectStatsFixture = {
  totalProjects: 20,
  activeProjects: 12,
  onHoldProjects: 3,
  droppedProjects: 2,
  doneProjects: 3,
  sequentialProjects: 4,
  parallelProjects: 8,
  avgTasksPerProject: 6.5,
  avgRemainingPerProject: 2.1,
  avgCompletionRate: 61,
  projectsWithMostTasks: [{ name: 'House renovation', taskCount: 12 }],
  projectsWithMostRemaining: [{ name: 'House renovation', remainingCount: 5 }],
};

const tagStatsFixture = {
  totalTags: 15,
  activeTags: 12,
  tagsWithTasks: 9,
  unusedTags: 6,
  avgTasksPerTag: 3.2,
  mostUsedTags: [{ name: 'errands', taskCount: 4 }],
  leastUsedTags: [{ name: 'shops', taskCount: 1 }],
  staleTags: [{ name: 'old-hobby', daysSinceActivity: 120 }],
};

const batchResultFixture = [
  { id: 'kXu3B-LZfFH', ok: true, task: taskFixture },
  { id: 'missing-id', ok: false, error: 'Task not found: missing-id' },
];

const perspectiveFixture = { id: 'Inbox', name: 'Inbox' };

// --- Mock OmniFocus returning the fixtures ---

const RETURNS: Record<string, unknown> = {
  listTasks: [taskFixture],
  getTask: taskFixture,
  createTask: taskFixture,
  updateTask: taskFixture,
  updateTasks: batchResultFixture,
  dropTask: taskFixture,
  deleteTask: undefined,
  searchTasks: [taskFixture],
  convertTaskToProject: projectFixture,
  setTaskRepeat: taskFixture,
  moveTask: taskFixture,
  duplicateTask: taskFixture,
  parseTasks: [taskFixture],
  getTaskStats: taskStatsFixture,
  listInboxTasks: [taskFixture],
  getInboxCount: 3,
  cleanupInbox: { inboxBefore: 3, assigned: 2, inboxAfter: 0 },
  listProjects: [projectFixture],
  getProject: projectFixture,
  createProject: projectFixture,
  updateProject: projectFixture,
  completeProject: projectFixture,
  deleteProject: undefined,
  searchProjects: [projectFixture],
  listProjectsDueForReview: [projectFixture],
  markProjectReviewed: projectFixture,
  getProjectStats: projectStatsFixture,
  listPerspectives: [perspectiveFixture],
  getPerspectiveTasks: [taskFixture],
  listTags: [tagFixture],
  getTag: tagFixture,
  createTag: tagFixture,
  updateTag: tagFixture,
  deleteTag: undefined,
  searchTags: [tagFixture],
  getTagStats: tagStatsFixture,
  listFolders: [folderFixture],
  getFolder: folderFixture,
  createFolder: folderFixture,
  updateFolder: folderFixture,
  deleteFolder: undefined,
  searchFolders: [folderFixture],
  undo: { undone: true },
  redo: { redone: true },
  syncNow: { saved: true },
};

function makeFixtureOf(): OmniFocus {
  const of: Record<string, unknown> = {};
  for (const [method, value] of Object.entries(RETURNS)) {
    of[method] = async () => value;
  }
  return of as unknown as OmniFocus;
}

/** Minimal valid arguments per tool (tools not listed take no arguments). */
const TOOL_ARGS: Record<string, Record<string, unknown>> = {
  get_task: { idOrName: 'x' },
  create_task: { name: 'x' },
  update_task: { idOrName: 'x' },
  update_tasks: { ids: ['t1', 't2'] },
  drop_task: { idOrName: 'x' },
  delete_task: { idOrName: 'x' },
  search_tasks: { query: 'x' },
  convert_task_to_project: { idOrName: 'x' },
  set_task_repeat: { idOrName: 'x', rule: 'FREQ=DAILY' },
  move_task: { idOrName: 'x', to: { inbox: true } },
  duplicate_task: { idOrName: 'x' },
  parse_tasks: { text: 'Buy milk' },
  cleanup_inbox: {},
  get_project: { idOrName: 'x' },
  create_project: { name: 'x' },
  update_project: { idOrName: 'x' },
  complete_project: { idOrName: 'x' },
  delete_project: { idOrName: 'x' },
  search_projects: { query: 'x' },
  mark_project_reviewed: { idOrName: 'x' },
  get_perspective_tasks: { name: 'Inbox' },
  get_tag: { idOrName: 'x' },
  create_tag: { name: 'x' },
  update_tag: { idOrName: 'x' },
  delete_tag: { idOrName: 'x' },
  search_tags: { query: 'x' },
  get_folder: { idOrName: 'x' },
  create_folder: { name: 'x' },
  update_folder: { idOrName: 'x' },
  delete_folder: { idOrName: 'x' },
  search_folders: { query: 'x' },
  search_tools: { query: 'task' },
};

describe('every tool declares an outputSchema', () => {
  it('has a parseable zod object schema on all tools', () => {
    for (const t of buildTools(makeFixtureOf())) {
      expect(t.outputSchema, t.name).toBeDefined();
      expect(typeof t.outputSchema.safeParse, t.name).toBe('function');
    }
  });
});

describe('structuredContent validates against each tool outputSchema', () => {
  const tools: ToolSpec[] = buildTools(makeFixtureOf());

  for (const t of tools) {
    it(`${t.name}: handler output parses against its outputSchema`, async () => {
      const result = await t.handler(TOOL_ARGS[t.name] ?? {});
      expect(result.isError, `${t.name} unexpectedly errored`).toBeUndefined();
      expect(result.structuredContent, `${t.name} missing structuredContent`).toBeDefined();
      const parsed = t.outputSchema.safeParse(result.structuredContent);
      expect(
        parsed.success,
        `${t.name}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2)}`
      ).toBe(true);
    });
  }
});

describe('structuredResponse wrapping convention', () => {
  it('wraps array results as {items, count} while text keeps the raw array', () => {
    const result = structuredResponse([taskFixture]);
    expect(result.structuredContent).toEqual({ items: [taskFixture], count: 1 });
    const text = (result.content[0] as { text: string }).text;
    expect(text.trimStart().startsWith('[')).toBe(true);
    expect(JSON.parse(text)).toEqual([taskFixture]);
  });

  it('passes object results through unwrapped, with matching text', () => {
    const result = structuredResponse({ count: 3 });
    expect(result.structuredContent).toEqual({ count: 3 });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ count: 3 });
  });

  it('list tools carry the wrapped object in structuredContent', async () => {
    const tools = buildTools(makeFixtureOf());
    const listTasks = tools.find((t) => t.name === 'list_tasks');
    if (!listTasks) throw new Error('list_tasks not found');
    const result = await listTasks.handler({});
    expect(result.structuredContent).toEqual({ items: [taskFixture], count: 1 });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual([taskFixture]);
  });
});

describe('error results carry no structuredContent', () => {
  it('isError results omit structuredContent so the SDK skips validation', async () => {
    const of = makeFixtureOf() as unknown as Record<string, unknown>;
    of.getTask = async () => {
      throw new Error('Task not found: xyz');
    };
    const tools = buildTools(of as unknown as OmniFocus);
    const getTask = tools.find((t) => t.name === 'get_task');
    if (!getTask) throw new Error('get_task not found');
    const result = await getTask.handler({ idOrName: 'xyz' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });

  it('structuredError is the shared helper def() and the app tools both use', () => {
    // apps.ts hand-rebuilt this shape before being pointed at the exported
    // helper; pin the contract so it can't drift back apart.
    const result = structuredError(new Error('Task not found: xyz'));
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      error: { name: 'omnifocus_error', detail: 'Task not found: xyz', statusCode: 404 },
    });
  });
});

describe('structuredResponse null/primitive guard', () => {
  // Audited: every current handler resolves to an object or array (verified
  // by the "every tool declares an outputSchema" + drift-guard suites above,
  // which exercise all 46 catalogue tools). No live path hits this branch
  // today, but wrapping defensively means a future primitive-returning
  // handler degrades to {value: ...} instead of corrupting structuredContent.
  it('wraps a primitive as {value} instead of casting it to an object', () => {
    expect(structuredResponse('plain string').structuredContent).toEqual({ value: 'plain string' });
    expect(structuredResponse(42).structuredContent).toEqual({ value: 42 });
    expect(structuredResponse(null).structuredContent).toEqual({ value: null });
  });
});

describe('schema strictness (mismatch guard)', () => {
  it('TaskSchema rejects a fixture missing a required field', () => {
    const { url: _url, ...withoutUrl } = taskFixture;
    expect(TaskSchema.safeParse(withoutUrl).success).toBe(false);
  });

  it('TaskSchema rejects a mistyped field', () => {
    expect(TaskSchema.safeParse({ ...taskFixture, completed: 'yes' }).success).toBe(false);
  });

  it('TaskSchema accepts unknown extra fields (forward compatibility)', () => {
    expect(TaskSchema.safeParse({ ...taskFixture, futureField: 42 }).success).toBe(true);
  });

  it('TaskSchema accepts one level of children (get_task includeChildren)', () => {
    const child = { ...taskFixture, id: 'child-1', parentId: taskFixture.id };
    expect(TaskSchema.safeParse({ ...taskFixture, children: [child] }).success).toBe(true);
  });

  it('FolderSchema accepts nested folder recursion and rejects malformed children', () => {
    expect(FolderSchema.safeParse(folderFixture).success).toBe(true);
    const bad = { ...folderFixture, children: [{ id: 'only-an-id' }] };
    expect(FolderSchema.safeParse(bad).success).toBe(false);
  });

  it("TagSchema accepts 'done', widened defensively beyond today's live enum", () => {
    // Live-probed on OmniFocus 4.8.12: Tag.Status has no Done member today,
    // so tagStatusToString(tag.status) can never actually emit 'done' for a
    // tag. But it shares statusToString(status, StatusEnum) with
    // projectStatusToString, which DOES emit 'done' — if a future OmniFocus
    // adds Tag.Status.Done, the shared serializer would emit it too. Listed
    // defensively so that day doesn't turn a successful read into isError.
    expect(TagSchema.safeParse({ ...tagFixture, status: 'done' }).success).toBe(true);
  });

  it('RepetitionSchema requires ruleString/catchUpAutomatically because the serializer never omits them', () => {
    // Live-probed on OmniFocus 4.8.12 against BOTH constructor forms:
    // - modern 5-arg `new Task.RepetitionRule(rule, null, scheduleType,
    //   anchorDateKey, catchUp)`
    // - deprecated 2-arg `new Task.RepetitionRule(rule, RepetitionMethod)`
    // Both populate ruleString (string) and catchUpAutomatically (boolean,
    // defaults false) unconditionally, and scheduleType/anchorDateKey are
    // always a real enum member — serializeRepetition's if/else chains
    // default any unrecognised member to 'regularly'/'dueDate' rather than
    // leaving the field undefined. So a schema requiring these fields
    // matches the serializer's actual guarantee; loosening them to optional
    // would only hide real drift. Enums are pinned to the three/three
    // documented members for the same reason — OmniFocus does not expose a
    // way to enumerate them for a forward-compat test, so this fixture
    // stands in as the recorded evidence.
    expect(RepetitionSchema.safeParse(repetitionFixture).success).toBe(true);
    expect(
      RepetitionSchema.safeParse({ ...repetitionFixture, ruleString: undefined }).success
    ).toBe(false);
  });
});

describe('app tool schemas', () => {
  it('StatsDashboardSchema accepts the combined stats payload', () => {
    const payload = {
      tasks: taskStatsFixture,
      projects: projectStatsFixture,
      tags: tagStatsFixture,
    };
    expect(StatsDashboardSchema.safeParse(payload).success).toBe(true);
  });

  it('TriageResultSchema accepts the triage payload', () => {
    const payload = { filter: 'inbox', total: 1, shown: 1, tasks: [taskFixture] };
    expect(TriageResultSchema.safeParse(payload).success).toBe(true);
  });
});
