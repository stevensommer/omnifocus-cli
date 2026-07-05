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
