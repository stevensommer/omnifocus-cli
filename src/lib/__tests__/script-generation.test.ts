import { describe, expect, it } from 'vitest';
import { OmniFocus } from '../omnifocus.js';

/**
 * Regression tests for the generated Omni Automation scripts. These intercept
 * the private executeJXA seam so the exact script text can be asserted without
 * OmniFocus or osascript (no `vi` — the suite must pass under both `vitest`
 * and bun's native runner).
 */

interface CapturedCall {
  script: string;
  opts: { timeoutMs?: number; signal?: AbortSignal } | undefined;
}

function captureScript(returnValue: string): {
  of: OmniFocus;
  scripts: string[];
  calls: CapturedCall[];
} {
  const of = new OmniFocus();
  const scripts: string[] = [];
  const calls: CapturedCall[] = [];
  (
    of as unknown as {
      executeJXA: (script: string, opts?: CapturedCall['opts']) => Promise<string>;
    }
  ).executeJXA = async (script, opts) => {
    scripts.push(script);
    calls.push({ script, opts });
    return returnValue;
  };
  return { of, scripts, calls };
}

describe('updateProject script generation', () => {
  it('moves a project to a folder via moveSections, not the nonexistent moveProjects', async () => {
    // moveProjects is not a real Omni Automation global (verified on
    // OmniFocus 4.8.12: typeof moveProjects === "undefined"); emitting it
    // makes every folder move throw a ReferenceError inside OmniFocus.
    const { of, scripts } = captureScript('{}');
    await of.updateProject('My Project', { folder: 'Work' });
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain('moveSections([project], targetFolder)');
    expect(scripts[0]).not.toContain('moveProjects(');
  });

  it('omits the folder move when no folder is given', async () => {
    const { of, scripts } = captureScript('{}');
    await of.updateProject('My Project', { name: 'Renamed' });
    expect(scripts[0]).not.toContain('moveSections(');
  });
});

describe('updateTask script generation', () => {
  it('moves a task to a project via moveTasks', async () => {
    const { of, scripts } = captureScript('{}');
    await of.updateTask('My Task', { project: 'House' });
    expect(scripts[0]).toContain('moveTasks([task], targetProject)');
  });

  it('accepts ISO date/defer/due/planned values', async () => {
    const { of, scripts } = captureScript('{}');
    await of.updateTask('My Task', {
      due: '2026-08-01',
      defer: '2026-07-01T09:00:00',
      planned: '2026-07-15',
    });
    expect(scripts[0]).toContain('task.dueDate = new Date(');
    expect(scripts[0]).toContain('task.deferDate = new Date(');
    expect(scripts[0]).toContain('task.plannedDate = new Date(');
  });

  it.each([
    'due',
    'defer',
    'planned',
  ] as const)('rejects an unparseable %s date with a 400 before touching OmniFocus', async (field) => {
    const { of, scripts } = captureScript('{}');
    await expect(of.updateTask('My Task', { [field]: 'not-a-date' })).rejects.toThrow(
      `Invalid ${field} date`
    );
    expect(scripts).toHaveLength(0);
  });

  it.each([
    'due',
    'defer',
    'planned',
  ] as const)('rejects an ambiguous %s date (accepted by bare Date parsing, but not ISO) with a 400', async (field) => {
    // Regression for the batch-update finding: new Date("Jan 5") does NOT
    // throw, it silently resolves to some other year — confirmed live
    // against OmniFocus 4.8.12 (updateTasks with due: "Jan 5" wrote
    // 2000-01-04 with no error). Requiring the documented ISO shape
    // (YYYY-MM-DD[THH:mm:ss]) turns that silent corruption into a 400.
    const { of, scripts } = captureScript('{}');
    await expect(of.updateTask('My Task', { [field]: 'Jan 5' })).rejects.toThrow(
      `Invalid ${field} date`
    );
    expect(scripts).toHaveLength(0);
  });
});

describe('listTasks filter generation', () => {
  it('status filter maps to stringToTaskStatus comparison', async () => {
    const { of, scripts } = captureScript('[]');
    await of.listTasks({ status: 'blocked' });
    // The inner script is JSON-embedded by wrapOmniScript, so its double
    // quotes appear escaped in the captured text.
    expect(scripts[0]).toContain('stringToTaskStatus(\\"blocked\\")');
  });

  it('actionable pseudo-status uses isActionableStatus', async () => {
    const { of, scripts } = captureScript('[]');
    await of.listTasks({ status: 'actionable' });
    expect(scripts[0]).toContain('isActionableStatus(task.taskStatus)');
  });

  it('flagged filter no longer conflates flagged with available', async () => {
    const { of, scripts } = captureScript('[]');
    await of.listTasks({ flagged: true });
    expect(scripts[0]).toContain('if (!task.flagged) continue;');
    expect(scripts[0]).not.toContain('Task.Status.Available) continue');
  });

  it('due windows compare effective due dates', async () => {
    const { of, scripts } = captureScript('[]');
    await of.listTasks({ dueBefore: '2026-08-01', dueAfter: '2026-07-01' });
    expect(scripts[0]).toContain('task.effectiveDueDate');
    expect(scripts[0]).toContain('2026-08-01');
    expect(scripts[0]).toContain('2026-07-01');
  });

  it('completedAfter implies including completed tasks', async () => {
    const { of, scripts } = captureScript('[]');
    await of.listTasks({ completedAfter: '2026-07-01' });
    expect(scripts[0]).not.toContain('if (task.completed) continue;');
    expect(scripts[0]).toContain('task.completionDate');
  });

  it('status completed keeps completed tasks without leaking dropped ones', async () => {
    // Regression for the false claim that completed filters "always return
    // empty". On OmniFocus 4.x effectiveActive === true for completed tasks
    // and false only for dropped (verified live on 4.8.12), so with
    // status:'completed' the generated script must:
    //   1. NOT drop completed tasks — the `if (task.completed) continue;` guard
    //      is absent.
    //   2. STILL retain the effectiveActive guard — completed tasks pass it
    //      (effectiveActive === true), while dropped tasks are correctly kept
    //      out. Removing this guard is the wrong "fix" and would leak dropped
    //      tasks into a completed listing.
    const { of, scripts } = captureScript('[]');
    await of.listTasks({ status: 'completed' });
    expect(scripts[0]).not.toContain('if (task.completed) continue;');
    expect(scripts[0]).toContain('if (!task.effectiveActive) continue;');
  });

  it('status dropped implies inclusion of dropped tasks', async () => {
    const { of, scripts } = captureScript('[]');
    await of.listTasks({ status: 'dropped' });
    expect(scripts[0]).not.toContain('if (!task.effectiveActive) continue;');
  });

  it('rejects invalid ISO dates with a 400 before touching OmniFocus', async () => {
    const { of, scripts } = captureScript('[]');
    await expect(of.listTasks({ dueBefore: 'not-a-date' })).rejects.toThrow(
      'Invalid dueBefore date'
    );
    expect(scripts).toHaveLength(0);
  });
});

describe('serializer coverage', () => {
  it('serializeTask includes status, effective dates, dropDate, and url', async () => {
    const { of, scripts } = captureScript('[]');
    await of.listTasks();
    expect(scripts[0]).toContain('taskStatus: taskStatusToString(task.taskStatus)');
    // task.dropped does not exist in Omni Automation — it must be derived.
    expect(scripts[0]).toContain('dropped: task.dropDate !== null');
    expect(scripts[0]).not.toContain('dropped: task.dropped');
    expect(scripts[0]).toContain('effectiveDue: isoOrNull(task.effectiveDueDate)');
    expect(scripts[0]).toContain('dropDate: isoOrNull(task.dropDate)');
    expect(scripts[0]).toContain("url: objectUrl(task, 'task')");
    // A genuine 0-minute estimate must survive serialisation. `x || null`
    // would coerce 0 to null; numberOrNull only maps null/undefined to null.
    expect(scripts[0]).toContain('estimatedMinutes: numberOrNull(task.estimatedMinutes)');
    expect(scripts[0]).not.toContain('task.estimatedMinutes || null');
  });

  it('serializeProject includes dates, flagged, nextTask, and url', async () => {
    const { of, scripts } = captureScript('{}');
    await of.getProject('X');
    expect(scripts[0]).toContain('flagged: project.flagged');
    expect(scripts[0]).toContain('due: isoOrNull(project.dueDate)');
    expect(scripts[0]).toContain('nextTask: nextTask ?');
    expect(scripts[0]).toContain("url: objectUrl(project, 'project')");
    expect(scripts[0]).toContain('estimatedMinutes: numberOrNull(project.estimatedMinutes)');
    expect(scripts[0]).not.toContain('project.estimatedMinutes || null');
  });

  it('lookups try byIdentifier before scanning by name', async () => {
    const { of, scripts } = captureScript('{}');
    await of.getTask('abc');
    expect(scripts[0]).toContain('Task.byIdentifier(idOrName)');
    expect(scripts[0]).toContain('Project.byIdentifier(idOrName)');
    expect(scripts[0]).toContain('Tag.byIdentifier(idOrName)');
  });
});

describe('createTask script generation', () => {
  it('emits an explicit 0-minute estimate instead of dropping it', async () => {
    // `options.estimatedMinutes ? ...` would treat a real 0 as falsy and skip
    // the assignment; the guard must be a null check so a deliberate 0 sticks.
    const { of, scripts } = captureScript('{}');
    await of.createTask({ name: 'Quick note', estimatedMinutes: 0 });
    expect(scripts[0]).toContain('task.estimatedMinutes = 0;');
  });

  it('omits the estimate assignment when none is given', async () => {
    const { of, scripts } = captureScript('{}');
    await of.createTask({ name: 'No estimate' });
    expect(scripts[0]).not.toContain('task.estimatedMinutes =');
  });
});

describe('completeProject script generation', () => {
  it('uses markComplete, not raw status assignment (repeating projects)', async () => {
    const { of, scripts } = captureScript('{}');
    await of.completeProject('P');
    expect(scripts[0]).toContain('project.markComplete();');
    expect(scripts[0]).not.toContain('Project.Status.Done');
    expect(scripts[0]).toContain('serializeProject(project)');
  });

  it('passes an explicit completion date through to markComplete', async () => {
    const { of, scripts } = captureScript('{}');
    await of.completeProject('P', { date: '2026-07-01' });
    expect(scripts[0]).toContain('project.markComplete(new Date(');
    expect(scripts[0]).toContain('2026-07-01');
  });

  it('incomplete uses markIncomplete', async () => {
    const { of, scripts } = captureScript('{}');
    await of.completeProject('P', { incomplete: true });
    expect(scripts[0]).toContain('project.markIncomplete();');
    expect(scripts[0]).not.toContain('markComplete(');
  });

  it('rejects an invalid completion date with a 400 before touching OmniFocus', async () => {
    const { of, scripts } = captureScript('{}');
    await expect(of.completeProject('P', { date: 'nope' })).rejects.toThrow(
      'Invalid completion date'
    );
    expect(scripts).toHaveLength(0);
  });
});

describe('review workflow script generation', () => {
  it('serializeProject includes reviewInterval, lastReviewDate, and nextReviewDate', async () => {
    const { of, scripts } = captureScript('{}');
    await of.getProject('X');
    expect(scripts[0]).toContain('steps: project.reviewInterval.steps');
    expect(scripts[0]).toContain('unit: project.reviewInterval.unit');
    expect(scripts[0]).toContain('lastReviewDate: isoOrNull(project.lastReviewDate)');
    expect(scripts[0]).toContain('nextReviewDate: isoOrNull(project.nextReviewDate)');
  });

  it('listProjectsDueForReview compares nextReviewDate headlessly', async () => {
    const { of, scripts } = captureScript('[]');
    await of.listProjectsDueForReview();
    expect(scripts[0]).toContain('project.nextReviewDate');
    expect(scripts[0]).toContain('Project.Status.Dropped');
    expect(scripts[0]).not.toContain('Perspective');
    expect(scripts[0]).not.toContain('windows');
  });

  it('markProjectReviewed sets lastReviewDate to now', async () => {
    const { of, scripts } = captureScript('{}');
    await of.markProjectReviewed('P');
    expect(scripts[0]).toContain('project.lastReviewDate = new Date();');
  });

  it('review interval mutates the value object and assigns it back', async () => {
    // Project.ReviewInterval is a value object: property writes on the live
    // value do nothing — the docs require copy, mutate, assign back.
    const { of, scripts } = captureScript('{}');
    await of.updateProject('P', { reviewInterval: '2 weeks' });
    expect(scripts[0]).toContain('const ri = project.reviewInterval;');
    expect(scripts[0]).toContain('ri.steps = 2;');
    expect(scripts[0]).toContain('ri.unit = \\"weeks\\"');
    expect(scripts[0]).toContain('project.reviewInterval = ri;');
  });

  it('parses singular units and applies on create too', async () => {
    const { of, scripts } = captureScript('{}');
    await of.createProject({ name: 'P', reviewInterval: '1 month' });
    expect(scripts[0]).toContain('ri.steps = 1;');
    expect(scripts[0]).toContain('ri.unit = \\"months\\"');
  });

  it('rejects an unparseable review interval with a 400 before touching OmniFocus', async () => {
    const { of, scripts } = captureScript('{}');
    await expect(of.updateProject('P', { reviewInterval: 'fortnightly' })).rejects.toThrow(
      'Invalid review interval'
    );
    expect(scripts).toHaveLength(0);
  });
});

describe('updateTasks batch script generation', () => {
  it('loops over ids in one script with per-id try/catch results', async () => {
    const { of, scripts } = captureScript('[]');
    await of.updateTasks(['t1', 't2'], { flagged: true });
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain('[\\"t1\\",\\"t2\\"]');
    expect(scripts[0]).toContain('const task = findTask(id);');
    expect(scripts[0]).toContain('task.flagged = true;');
    expect(scripts[0]).toContain('results.push({ id: id, ok: true, task: serializeTask(task) });');
    expect(scripts[0]).toContain('ok: false');
  });

  it('batch complete emits markComplete', async () => {
    const { of, scripts } = captureScript('[]');
    await of.updateTasks(['t1'], { completed: true });
    expect(scripts[0]).toContain('task.markComplete();');
  });

  it('date shifts read the current date, add days, and write back', async () => {
    const { of, scripts } = captureScript('[]');
    await of.updateTasks(['t1'], { shiftDueDays: 3, shiftDeferDays: -2 });
    expect(scripts[0]).toContain('const d = task.dueDate;');
    expect(scripts[0]).toContain('d.setDate(d.getDate() + 3)');
    expect(scripts[0]).toContain('const d = task.deferDate;');
    expect(scripts[0]).toContain('d.setDate(d.getDate() + -2)');
    // Tasks without the date are skipped, not failed.
    expect(scripts[0]).toContain('if (d) {');
    expect(scripts[0]).not.toContain('task.plannedDate = d;');
  });

  it('rejects an empty id list and non-integer shifts with a 400', async () => {
    const { of, scripts } = captureScript('[]');
    await expect(of.updateTasks([], { flagged: true })).rejects.toThrow('No task ids given');
    await expect(of.updateTasks(['t1'], { shiftDueDays: 1.5 })).rejects.toThrow(
      'Invalid shiftDueDays'
    );
    expect(scripts).toHaveLength(0);
  });
});

describe('fuzzy matching script generation', () => {
  it('searchProjects uses projectsMatching (Quick Open semantics)', async () => {
    const { of, scripts } = captureScript('[]');
    await of.searchProjects('reno');
    expect(scripts[0]).toContain('projectsMatching(\\"reno\\")');
  });

  it('searchTags uses tagsMatching', async () => {
    const { of, scripts } = captureScript('[]');
    await of.searchTags('err');
    expect(scripts[0]).toContain('tagsMatching(\\"err\\")');
  });

  it('searchFolders uses foldersMatching', async () => {
    const { of, scripts } = captureScript('[]');
    await of.searchFolders('wrk');
    expect(scripts[0]).toContain('foldersMatching(\\"wrk\\")');
  });

  it('find helpers are exact-match only: no *Matching fallback', async () => {
    // SAFETY: find* is used exclusively by mutating/destructive paths
    // (update, delete, move-into, inbox-file). Falling back to a fuzzy
    // Quick Open match there would let a typo silently act on a guessed
    // object — e.g. `of folder delete Wrk` deleting "Work" instead of
    // erroring. Fuzzy matching must stay confined to the dedicated
    // search_projects/search_tags/search_folders tools (asserted above),
    // which only return candidates for a human to look at, never act on
    // one automatically.
    const { of, scripts } = captureScript('{}');
    await of.getTask('abc');
    expect(scripts[0]).not.toContain('projectsMatching(idOrName)');
    expect(scripts[0]).not.toContain('tagsMatching(idOrName)');
    expect(scripts[0]).not.toContain('foldersMatching(idOrName)');
    expect(scripts[0]).not.toContain('resolveFuzzy');
    expect(scripts[0]).not.toContain('Close matches');
    expect(scripts[0]).toContain('function findProject(idOrName) {');
    expect(scripts[0]).toContain('throw new Error(\\"Project not found: \\" + idOrName);');
    expect(scripts[0]).toContain('throw new Error(\\"Folder not found: \\" + idOrName);');
    expect(scripts[0]).toContain('throw new Error(\\"Tag not found: \\" + idOrName);');
  });
});

describe('cleanupInbox script generation', () => {
  it('runs cleanUp() without touching containers when no container is given', async () => {
    const { of, scripts } = captureScript('{"inboxBefore":2,"assigned":0,"inboxAfter":2}');
    await of.cleanupInbox();
    expect(scripts[0]).toContain('cleanUp();');
    expect(scripts[0]).not.toContain('assignedContainer');
  });

  it('assigns only unassigned inbox tasks to the container, then cleans up', async () => {
    const { of, scripts } = captureScript('{"inboxBefore":2,"assigned":2,"inboxAfter":0}');
    await of.cleanupInbox({ container: 'Someday' });
    expect(scripts[0]).toContain('findProject(\\"Someday\\")');
    expect(scripts[0]).toContain('if (task.assignedContainer === null)');
    expect(scripts[0]).toContain('task.assignedContainer = target;');
    expect(scripts[0]).toContain('cleanUp();');
  });
});

describe('undo/redo/sync script generation', () => {
  it('undo is guarded by canUndo', async () => {
    const { of, scripts } = captureScript('{"undone":true}');
    const result = await of.undo();
    expect(result).toEqual({ undone: true });
    expect(scripts[0]).toContain('if (!canUndo)');
    expect(scripts[0]).toContain('undo();');
  });

  it('redo is guarded by canRedo', async () => {
    const { of, scripts } = captureScript('{"redone":true}');
    await of.redo();
    expect(scripts[0]).toContain('if (!canRedo)');
    expect(scripts[0]).toContain('redo();');
  });

  it('syncNow calls save()', async () => {
    const { of, scripts } = captureScript('{"saved":true}');
    const result = await of.syncNow();
    expect(result).toEqual({ saved: true });
    expect(scripts[0]).toContain('save();');
  });
});

describe('folder CRUD script generation', () => {
  it('createFolder constructs a Folder, optionally under a parent', async () => {
    const { of, scripts } = captureScript('{}');
    await of.createFolder({ name: 'Areas' });
    expect(scripts[0]).toContain('new Folder(\\"Areas\\")');

    const second = captureScript('{}');
    await second.of.createFolder({ name: 'Areas', parent: 'Life' });
    expect(second.scripts[0]).toContain('findFolder(\\"Life\\")');
    expect(second.scripts[0]).toContain('new Folder(\\"Areas\\", parentFolder)');
  });

  it('updateFolder renames, sets status, and moves via moveSections', async () => {
    const { of, scripts } = captureScript('{}');
    await of.updateFolder('Areas', { name: 'Zones', status: 'dropped', parent: 'Archive' });
    expect(scripts[0]).toContain('folder.name = \\"Zones\\";');
    expect(scripts[0]).toContain('folder.status = stringToFolderStatus(\\"dropped\\");');
    expect(scripts[0]).toContain('moveSections([folder], destFolder)');
  });

  it('deleteFolder deletes via findFolder', async () => {
    const { of, scripts } = captureScript('');
    await of.deleteFolder('Areas');
    expect(scripts[0]).toContain('deleteObject(findFolder(\\"Areas\\"))');
  });

  it('findFolder has a byIdentifier fast path', async () => {
    const { of, scripts } = captureScript('{}');
    await of.getFolder('F123');
    expect(scripts[0]).toContain('Folder.byIdentifier(idOrName)');
  });
});

describe('convertTaskToProject script generation', () => {
  it('converts via convertTasksToProjects to the end of the library by default', async () => {
    const { of, scripts } = captureScript('{}');
    await of.convertTaskToProject('t1');
    expect(scripts[0]).toContain('const destination = library.ending;');
    expect(scripts[0]).toContain('convertTasksToProjects([task], destination)');
    expect(scripts[0]).toContain('serializeProject(newProjects[0])');
  });

  it('targets a named folder when given', async () => {
    const { of, scripts } = captureScript('{}');
    await of.convertTaskToProject('t1', { folder: 'Work' });
    expect(scripts[0]).toContain('findFolder(\\"Work\\")');
    expect(scripts[0]).not.toContain('library.ending');
  });
});

describe('dropTask script generation', () => {
  it('calls task.drop with allOccurrences and reserialises', async () => {
    const { of, scripts } = captureScript('{}');
    await of.dropTask('t1', { allOccurrences: true });
    expect(scripts[0]).toContain('task.drop(true)');
    expect(scripts[0]).toContain('serializeTask(task)');
  });

  it('defaults allOccurrences to false', async () => {
    const { of, scripts } = captureScript('{}');
    await of.dropTask('t1');
    expect(scripts[0]).toContain('task.drop(false)');
  });
});

describe('inbox tools are headless', () => {
  it('listInboxTasks iterates the inbox global instead of a window perspective', async () => {
    const { of, scripts } = captureScript('[]');
    await of.listInboxTasks();
    expect(scripts[0]).toContain('for (const task of inbox)');
    expect(scripts[0]).not.toContain('windows');
    expect(scripts[0]).not.toContain('Perspective');
  });

  // The inbox global retains completed and dropped root items (verified on
  // OmniFocus 4.8.12), so both inbox tools must filter them out to match the
  // old Inbox-perspective behaviour and to agree with each other.
  it('listInboxTasks skips completed and dropped items', async () => {
    const { of, scripts } = captureScript('[]');
    await of.listInboxTasks();
    expect(scripts[0]).toContain('if (task.completed) continue;');
    expect(scripts[0]).toContain('if (!task.effectiveActive) continue;');
  });

  it('getInboxCount counts only active, incomplete items (not inbox.length)', async () => {
    const { of, scripts } = captureScript('{"count": 4}');
    const count = await of.getInboxCount();
    expect(count).toBe(4);
    expect(scripts[0]).not.toContain('windows');
    // Must apply the same filter as listInboxTasks so the two always agree.
    expect(scripts[0]).toContain('if (task.completed) continue;');
    expect(scripts[0]).toContain('if (!task.effectiveActive) continue;');
    // A raw inbox.length would recount completed/dropped items.
    expect(scripts[0]).not.toContain('inbox.length');
  });
});

describe('getPerspectiveTasks cancellation plumbing', () => {
  it('forwards the AbortSignal and keeps the 60s timeout', async () => {
    const { of, calls } = captureScript('[]');
    const controller = new AbortController();
    await of.getPerspectiveTasks('Today', { signal: controller.signal });
    expect(calls[0].opts?.timeoutMs).toBe(60000);
    expect(calls[0].opts?.signal).toBe(controller.signal);
  });
});

// Real end-to-end abort: spawns osascript with a plain JXA sleep (no
// OmniFocus involved) and aborts it. macOS only — CI runs on ubuntu.
const itDarwin = process.platform === 'darwin' ? it : it.skip;

describe('executeJXA abort', () => {
  itDarwin(
    'kills the osascript child and reports a cancellation error',
    async () => {
      const of = new OmniFocus();
      const exec = (
        of as unknown as {
          executeJXA: (s: string, o?: { signal?: AbortSignal }) => Promise<string>;
        }
      ).executeJXA.bind(of);

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 200);
      const started = Date.now();
      await expect(
        exec('ObjC.import("Foundation"); $.NSThread.sleepForTimeInterval(15); "done";', {
          signal: controller.signal,
        })
      ).rejects.toThrow('Operation cancelled by client');
      // Must reject promptly after abort, not after the 15s sleep completes.
      expect(Date.now() - started).toBeLessThan(5000);
    },
    10000
  );

  // End-to-end confirmation that the abort path keys off Node's real
  // AbortError. The mislabel case (a genuine failure that merely coincides
  // with an aborted signal) is covered deterministically by the isAbortError
  // unit test below, which asserts a nonzero-exit error does NOT read as a
  // cancellation.
  itDarwin(
    'reports a cancellation when Node raises its abort error',
    async () => {
      const of = new OmniFocus();
      const exec = (
        of as unknown as {
          executeJXA: (s: string, o?: { signal?: AbortSignal }) => Promise<string>;
        }
      ).executeJXA.bind(of);

      // Pre-aborted signal: the child never spawns, so Node throws its
      // AbortError — proving the abort path still works end-to-end.
      const aborted = new AbortController();
      aborted.abort();
      await expect(exec('throw new Error("boom");', { signal: aborted.signal })).rejects.toThrow(
        'Operation cancelled by client'
      );
    },
    10000
  );

  // Unit-level guard for the classifier the catch block relies on.
  it('isAbortError only matches Node abort errors, not arbitrary failures', () => {
    const of = new OmniFocus();
    const isAbort = (of as unknown as { isAbortError: (e: unknown) => boolean }).isAbortError.bind(
      of
    );

    expect(isAbort({ name: 'AbortError' })).toBe(true);
    expect(isAbort({ code: 'ABORT_ERR' })).toBe(true);
    // A real osascript failure (nonzero exit) must NOT read as a cancellation.
    expect(isAbort({ name: 'Error', code: 3 })).toBe(false);
    expect(isAbort(new Error('OmniFocus: Task not found'))).toBe(false);
    expect(isAbort(null)).toBe(false);
    expect(isAbort('string error')).toBe(false);
  });
});
