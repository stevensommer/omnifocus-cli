import { execFile } from 'child_process';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { OmniFocusCliError } from './errors.js';
import type {
  Task,
  Project,
  TaskFilters,
  ProjectFilters,
  CreateTaskOptions,
  UpdateTaskOptions,
  UpdateTasksOptions,
  GetTaskOptions,
  SetTaskRepeatOptions,
  MoveTaskOptions,
  ParseTasksOptions,
  BatchUpdateResult,
  CreateProjectOptions,
  UpdateProjectOptions,
  CompleteProjectOptions,
  ConvertTaskToProjectOptions,
  Perspective,
  Tag,
  TagListOptions,
  TagStats,
  TaskStats,
  ProjectStats,
  CreateTagOptions,
  UpdateTagOptions,
  Folder,
  FolderFilters,
  CreateFolderOptions,
  UpdateFolderOptions,
  CleanupInboxResult,
} from '../types.js';

const execFileAsync = promisify(execFile);

export class OmniFocus {
  private readonly PROJECT_STATUS_MAP = {
    active: 'Active',
    'on hold': 'OnHold',
    dropped: 'Dropped',
  } as const;

  private readonly OMNI_HELPERS = `
    function isoOrNull(date) {
      return date ? date.toISOString() : null;
    }

    // Preserve a genuine 0 (e.g. an explicit 0-minute estimate) instead of
    // coercing it to null the way \`value || null\` would. OmniFocus emits a
    // real number 0 when estimatedMinutes is set to 0, and null when unset
    // (verified on OmniFocus 4.8.12), so only null/undefined should map to null.
    function numberOrNull(value) {
      return value != null ? value : null;
    }

    // Permalink for any database object. DatabaseObject.url exists from
    // OmniFocus 4.5 but returns null for unsaved objects, so fall back to
    // the documented omnifocus:///<kind>/<primaryKey> template.
    function objectUrl(obj, kind) {
      if (obj.url) return obj.url.string || String(obj.url);
      return 'omnifocus:///' + kind + '/' + obj.id.primaryKey;
    }

    function taskStatusToString(status) {
      if (status === Task.Status.Available) return 'available';
      if (status === Task.Status.Next) return 'next';
      if (status === Task.Status.Blocked) return 'blocked';
      if (status === Task.Status.DueSoon) return 'dueSoon';
      if (status === Task.Status.Overdue) return 'overdue';
      if (status === Task.Status.Completed) return 'completed';
      if (status === Task.Status.Dropped) return 'dropped';
      return 'available';
    }

    function stringToTaskStatus(str) {
      if (str === 'available') return Task.Status.Available;
      if (str === 'next') return Task.Status.Next;
      if (str === 'blocked') return Task.Status.Blocked;
      if (str === 'dueSoon') return Task.Status.DueSoon;
      if (str === 'overdue') return Task.Status.Overdue;
      if (str === 'completed') return Task.Status.Completed;
      if (str === 'dropped') return Task.Status.Dropped;
      throw new Error('Unknown task status: ' + str);
    }

    function isActionableStatus(status) {
      return status === Task.Status.Available || status === Task.Status.Next ||
             status === Task.Status.DueSoon || status === Task.Status.Overdue;
    }

    function serializeRepetition(rule) {
      if (!rule) return null;
      let scheduleType = 'regularly';
      if (rule.scheduleType === Task.RepetitionScheduleType.FromCompletion) scheduleType = 'fromCompletion';
      if (rule.scheduleType === Task.RepetitionScheduleType.None) scheduleType = 'none';
      let anchorDateKey = 'dueDate';
      if (rule.anchorDateKey === Task.AnchorDateKey.DeferDate) anchorDateKey = 'deferDate';
      if (rule.anchorDateKey === Task.AnchorDateKey.PlannedDate) anchorDateKey = 'plannedDate';
      return {
        ruleString: rule.ruleString,
        scheduleType: scheduleType,
        anchorDateKey: anchorDateKey,
        catchUpAutomatically: rule.catchUpAutomatically
      };
    }

    // Parent *task* id. A task sitting directly in a project has the
    // project's invisible root task as its .parent (Project.task is that
    // root task), which callers should see as "no parent task" — so it is
    // reported as null, as is an inbox-root task's null parent.
    function taskParentId(task) {
      const parent = task.parent;
      if (!parent) return null;
      const project = task.containingProject;
      if (project && parent.id.primaryKey === project.task.id.primaryKey) return null;
      return parent.id.primaryKey;
    }

    function serializeTask(task) {
      const containingProject = task.containingProject;
      const tagNames = task.tags.map(t => t.name);

      return {
        id: task.id.primaryKey,
        name: task.name,
        note: task.note || null,
        completed: task.completed,
        // Task has no .dropped property in Omni Automation (it serialized as
        // undefined and vanished from the JSON); own-droppedness is dropDate.
        dropped: task.dropDate !== null,
        effectivelyActive: task.effectiveActive,
        flagged: task.flagged,
        effectiveFlagged: task.effectiveFlagged,
        taskStatus: taskStatusToString(task.taskStatus),
        project: containingProject ? containingProject.name : null,
        parentId: taskParentId(task),
        hasChildren: task.hasChildren,
        childIds: task.children.map(c => c.id.primaryKey),
        sequential: task.sequential,
        inInbox: task.inInbox,
        repetition: serializeRepetition(task.repetitionRule),
        tags: tagNames,
        defer: isoOrNull(task.deferDate),
        due: isoOrNull(task.dueDate),
        planned: isoOrNull(task.plannedDate),
        effectiveDefer: isoOrNull(task.effectiveDeferDate),
        effectiveDue: isoOrNull(task.effectiveDueDate),
        estimatedMinutes: numberOrNull(task.estimatedMinutes),
        completionDate: isoOrNull(task.completionDate),
        dropDate: isoOrNull(task.dropDate),
        added: isoOrNull(task.added),
        modified: isoOrNull(task.modified),
        url: objectUrl(task, 'task')
      };
    }

    function serializeProject(project) {
      const parentFolder = project.parentFolder;
      const allTasks = project.flattenedTasks;
      const remainingTasks = allTasks.filter(t => !t.completed);
      const tagNames = project.tags.map(t => t.name);
      const nextTask = project.nextTask;

      return {
        id: project.id.primaryKey,
        name: project.name,
        note: project.note || null,
        status: projectStatusToString(project.status),
        folder: parentFolder ? parentFolder.name : null,
        sequential: project.sequential,
        flagged: project.flagged,
        defer: isoOrNull(project.deferDate),
        due: isoOrNull(project.dueDate),
        completionDate: isoOrNull(project.completionDate),
        dropDate: isoOrNull(project.dropDate),
        estimatedMinutes: numberOrNull(project.estimatedMinutes),
        completedByChildren: project.completedByChildren,
        containsSingletonActions: project.containsSingletonActions,
        nextTask: nextTask ? { id: nextTask.id.primaryKey, name: nextTask.name } : null,
        taskCount: allTasks.length,
        remainingCount: remainingTasks.length,
        tags: tagNames,
        reviewInterval: project.reviewInterval
          ? { steps: project.reviewInterval.steps, unit: project.reviewInterval.unit }
          : null,
        lastReviewDate: isoOrNull(project.lastReviewDate),
        nextReviewDate: isoOrNull(project.nextReviewDate),
        repetition: serializeRepetition(project.repetitionRule),
        url: objectUrl(project, 'project')
      };
    }

    function findTask(idOrName) {
      const byId = Task.byIdentifier(idOrName);
      if (byId) return byId;
      for (const task of flattenedTasks) {
        if (task.name === idOrName) {
          return task;
        }
      }
      throw new Error("Task not found: " + idOrName);
    }

    // find* helpers are exact-match only (id or exact name): every call site
    // is a mutating/destructive path (update, delete, move-into, inbox-file),
    // so a wrong guess is not a wrong read but a wrong write. Fuzzy Quick Open
    // matching is deliberately NOT offered here — it lives only in the
    // dedicated search_projects/search_tags/search_folders tools, where a
    // guess just returns candidates for the caller to look at, not act on.
    function findProject(idOrName) {
      const byId = Project.byIdentifier(idOrName);
      if (byId) return byId;
      for (const project of flattenedProjects) {
        if (project.name === idOrName) {
          return project;
        }
      }
      throw new Error("Project not found: " + idOrName);
    }

    function findFolder(idOrName) {
      const byId = Folder.byIdentifier(idOrName);
      if (byId) return byId;
      for (const folder of flattenedFolders) {
        if (folder.name === idOrName) {
          return folder;
        }
      }
      throw new Error("Folder not found: " + idOrName);
    }

    function getTagPath(tag) {
      const parts = [tag.name];
      let current = tag.parent;
      while (current) {
        parts.unshift(current.name);
        current = current.parent;
      }
      return parts.join('/');
    }

    function findTag(idOrName) {
      const byId = Tag.byIdentifier(idOrName);
      if (byId) return byId;

      if (idOrName.includes('/')) {
        for (const tag of flattenedTags) {
          if (getTagPath(tag) === idOrName) {
            return tag;
          }
        }
        throw new Error("Tag not found: " + idOrName);
      }

      const matches = flattenedTags.filter(tag => tag.name === idOrName);

      if (matches.length === 0) {
        throw new Error("Tag not found: " + idOrName);
      }

      if (matches.length > 1) {
        const paths = matches.map(getTagPath);
        throw new Error("Multiple tags found with name '" + idOrName + "'. Please use full path:\\n  " + paths.join('\\n  ') + "\\nOr use tag ID: " + matches.map(t => t.id.primaryKey).join(', '));
      }

      return matches[0];
    }

    function findByName(collection, name, typeName) {
      for (const item of collection) {
        if (item.name === name) {
          return item;
        }
      }
      throw new Error(typeName + " not found: " + name);
    }

    function assignTags(target, tagNames) {
      for (const tagName of tagNames) {
        const tag = findTag(tagName);
        target.addTag(tag);
      }
    }

    function replaceTagsOn(target, tagNames) {
      target.clearTags();
      assignTags(target, tagNames);
    }

    function statusToString(status, StatusEnum) {
      if (status === StatusEnum.Active) return 'active';
      if (status === StatusEnum.OnHold) return 'on hold';
      if (status === StatusEnum.Dropped) return 'dropped';
      if (status === StatusEnum.Done) return 'done';
      return 'dropped';
    }

    function stringToStatus(str, StatusEnum) {
      if (str === 'active') return StatusEnum.Active;
      if (str === 'on hold') return StatusEnum.OnHold;
      return StatusEnum.Dropped;
    }

    const projectStatusToString = (status) => statusToString(status, Project.Status);
    const tagStatusToString = (status) => statusToString(status, Tag.Status);
    const folderStatusToString = (status) => {
      if (status === Folder.Status.Active) return 'active';
      return 'dropped';
    };
    const stringToFolderStatus = (str) => {
      if (str === 'active') return Folder.Status.Active;
      if (str === 'dropped') return Folder.Status.Dropped;
      throw new Error('Unknown folder status: ' + str);
    };
    const stringToProjectStatus = (str) => stringToStatus(str, Project.Status);
    const stringToTagStatus = (str) => stringToStatus(str, Tag.Status);

    function serializeFolder(folder, includeDropped = false) {
      let childFolders = folder.folders;
      if (!includeDropped) {
        childFolders = childFolders.filter(c => c.effectiveActive);
      }

      return {
        id: folder.id.primaryKey,
        name: folder.name,
        status: folderStatusToString(folder.status),
        effectivelyActive: folder.effectiveActive,
        parent: folder.parent ? folder.parent.name : null,
        projectCount: folder.projects.length,
        remainingProjectCount: folder.projects.filter(p => p.effectiveActive).length,
        folderCount: folder.folders.length,
        children: childFolders.map(child => serializeFolder(child, includeDropped)),
        url: objectUrl(folder, 'folder')
      };
    }

    function computeTopItems(items, keyFn, topN = 5) {
      return items
        .sort((a, b) => b[keyFn] - a[keyFn])
        .slice(0, topN)
        .map(item => ({ name: item.name, [keyFn]: item[keyFn] }));
    }

    function computeAverage(total, count) {
      return count > 0 ? Math.round((total / count) * 10) / 10 : 0;
    }

    function serializeTag(tag, activeOnly = false) {
      const tasks = tag.tasks;
      const remainingTasks = tag.remainingTasks;
      const includedTasks = activeOnly ? remainingTasks : tasks;

      const dates = [];
      if (tag.added) dates.push(tag.added);
      if (tag.modified) dates.push(tag.modified);

      for (const task of includedTasks) {
        if (task.added) dates.push(task.added);
        if (task.modified) dates.push(task.modified);
        if (!activeOnly && task.completionDate) dates.push(task.completionDate);
        if (!activeOnly && task.effectiveCompletionDate) dates.push(task.effectiveCompletionDate);
      }

      const lastActivity = dates.length > 0
        ? dates.reduce((latest, current) => current > latest ? current : latest)
        : null;

      return {
        id: tag.id.primaryKey,
        name: tag.name,
        taskCount: includedTasks.length,
        remainingTaskCount: remainingTasks.length,
        added: tag.added ? tag.added.toISOString() : null,
        modified: tag.modified ? tag.modified.toISOString() : null,
        lastActivity: lastActivity ? lastActivity.toISOString() : null,
        active: tag.active,
        status: tagStatusToString(tag.status),
        parent: tag.parent ? tag.parent.name : null,
        children: tag.children.map(c => c.name),
        allowsNextAction: tag.allowsNextAction,
        url: objectUrl(tag, 'tag')
      };
    }
  `;

  private async executeJXA(
    script: string,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<string> {
    const { timeoutMs = 30000, signal } = opts;
    const tmpFile = join(tmpdir(), `omnifocus-${Date.now()}.js`);

    try {
      await writeFile(tmpFile, script, 'utf-8');

      const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', tmpFile], {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        // An aborted signal kills the osascript child, so a cancelled MCP
        // request doesn't leave OmniFocus mid-operation (e.g. half-way
        // through a perspective switch).
        signal,
      });

      return stdout.trim();
    } catch (error) {
      // Only treat this as a cancellation when Node's aborted-child error is
      // what actually surfaced (name === 'AbortError' / code === 'ABORT_ERR').
      // Checking signal.aborted alone would mislabel a genuine osascript
      // failure that merely coincided with an abort, masking the real error.
      if (this.isAbortError(error)) {
        throw new OmniFocusCliError('Operation cancelled by client', 499);
      }
      throw error;
    } finally {
      try {
        await unlink(tmpFile);
      } catch {
        /* ignore cleanup errors */
      }
    }
  }

  // Node reports an aborted execFile child with name 'AbortError' and code
  // 'ABORT_ERR' (verified on the Node runtime the CLI ships against). Match on
  // those rather than the ambient signal state so a real failure is never
  // reclassified as a cancellation.
  private isAbortError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const err = error as { name?: unknown; code?: unknown };
    return err.name === 'AbortError' || err.code === 'ABORT_ERR';
  }

  private escapeString(str: string): string {
    return str
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
  }

  private wrapOmniScript(omniScript: string): string {
    return `
      const app = Application('OmniFocus');
      app.includeStandardAdditions = true;
      const result = app.evaluateJavascript(${JSON.stringify(omniScript.trim())});
      result;
    `.trim();
  }

  // YYYY-MM-DD, optionally with a time component (space or "T" separated,
  // optional seconds/fraction, optional "Z" or +HH:mm offset) — the two
  // formats CLAUDE.md documents as accepted input. Deliberately stricter
  // than "anything new Date() can parse": bare `new Date(...)` also accepts
  // ambiguous strings like "Jan 5" or "2024" and silently resolves them to
  // some other date, rather than throwing — confirmed live (via updateTasks
  // with due: "Jan 5", which set the task's due date to 2000-01-04 with no
  // error at all). Requiring this shape turns that silent corruption into a
  // clean 400 instead.
  private static readonly ISO_DATE_RE =
    /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

  /**
   * Validate an ISO 8601 date/filter value and return it normalised for
   * embedding in the generated script. Rejecting here gives a clean 400
   * instead of a baffling empty result (or, for ambiguous input, a silently
   * wrong date) from a loose Date parse inside OmniFocus.
   */
  private isoDateArg(value: string, filterName: string): string {
    if (!OmniFocus.ISO_DATE_RE.test(value)) {
      throw new OmniFocusCliError(
        `Invalid ${filterName} date: "${value}" (expected ISO 8601, e.g. "2024-01-15" or "2024-01-15T10:00:00")`,
        400
      );
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new OmniFocusCliError(
        `Invalid ${filterName} date: "${value}" (expected ISO 8601)`,
        400
      );
    }
    return parsed.toISOString();
  }

  private buildTaskFilters(filters: TaskFilters): string {
    const conditions: string[] = [];

    // Asking for completed/dropped tasks by status or completion window
    // implies including them; otherwise those filters could never match.
    const wantsCompleted =
      filters.includeCompleted ||
      filters.status === 'completed' ||
      filters.completedBefore !== undefined ||
      filters.completedAfter !== undefined;
    const wantsDropped = filters.includeDropped || filters.status === 'dropped';

    if (!wantsCompleted) {
      conditions.push('if (task.completed) continue;');
    }
    // effectiveActive semantics on OmniFocus 4.x: it is TRUE for both active
    // AND completed tasks (verified live on 4.8.12 — completed tasks pass this
    // guard), and FALSE only for DROPPED tasks. So this guard is the *dropped*
    // filter, not a completed filter. Completed tasks are excluded solely by
    // the `task.completed` guard above. Do NOT "fix" completed-task filters by
    // touching this line — dropping it would leak dropped tasks into every
    // default listing, and completed filters already work because completed
    // tasks satisfy effectiveActive === true.
    if (!wantsDropped) {
      conditions.push('if (!task.effectiveActive) continue;');
    }
    if (filters.flagged) {
      // Flagged means flagged — availability is the status filter's job.
      // (Before status filters existed this also required Task.Status.Available.)
      conditions.push('if (!task.flagged) continue;');
    }
    if (filters.status) {
      if (filters.status === 'actionable') {
        conditions.push('if (!isActionableStatus(task.taskStatus)) continue;');
      } else {
        conditions.push(
          `if (task.taskStatus !== stringToTaskStatus("${filters.status}")) continue;`
        );
      }
    }

    // Date windows. Due/defer use effective dates (inherited from the
    // containing project/group); completed/added/planned are per-task.
    const windows: Array<[string | undefined, string, string, '<' | '>']> = [
      [filters.dueBefore, 'dueBefore', 'task.effectiveDueDate', '<'],
      [filters.dueAfter, 'dueAfter', 'task.effectiveDueDate', '>'],
      [filters.deferBefore, 'deferBefore', 'task.effectiveDeferDate', '<'],
      [filters.deferAfter, 'deferAfter', 'task.effectiveDeferDate', '>'],
      [filters.plannedBefore, 'plannedBefore', 'task.plannedDate', '<'],
      [filters.plannedAfter, 'plannedAfter', 'task.plannedDate', '>'],
      [filters.completedBefore, 'completedBefore', 'task.completionDate', '<'],
      [filters.completedAfter, 'completedAfter', 'task.completionDate', '>'],
      [filters.addedBefore, 'addedBefore', 'task.added', '<'],
      [filters.addedAfter, 'addedAfter', 'task.added', '>'],
    ];
    for (const [value, filterName, dateExpr, op] of windows) {
      if (value === undefined) continue;
      const iso = this.isoDateArg(value, filterName);
      conditions.push(
        `{ const d = ${dateExpr}; if (!d || !(d ${op} new Date("${iso}"))) continue; }`
      );
    }

    if (filters.project) {
      conditions.push(`
        if (!task.containingProject || task.containingProject.name !== "${this.escapeString(filters.project)}") {
          continue;
        }
      `);
    }
    if (filters.tag) {
      conditions.push(`
        if (!task.tags.some(t => t.name === "${this.escapeString(filters.tag)}")) {
          continue;
        }
      `);
    }

    return conditions.join('\n    ');
  }

  private buildProjectFilters(filters: ProjectFilters): string {
    const conditions: string[] = [];

    if (!filters.includeDropped) {
      conditions.push(
        'if (project.status === Project.Status.Dropped || project.status === Project.Status.Done) continue;'
      );
      conditions.push(
        'if (project.parentFolder && !project.parentFolder.effectiveActive) continue;'
      );
    }
    if (filters.status) {
      const statusCheck = this.PROJECT_STATUS_MAP[filters.status];
      conditions.push(`if (project.status !== Project.Status.${statusCheck}) continue;`);
    }
    if (filters.folder) {
      conditions.push(
        `if (!project.parentFolder || project.parentFolder.name !== "${this.escapeString(filters.folder)}") continue;`
      );
    }

    return conditions.join('\n    ');
  }

  private buildTaskUpdates(options: UpdateTaskOptions): string {
    if (options.project !== undefined && options.parent !== undefined) {
      throw new OmniFocusCliError(
        'Cannot set both project and parent: they are competing move destinations',
        400
      );
    }
    const updates: string[] = [];

    if (options.name !== undefined) {
      updates.push(`task.name = "${this.escapeString(options.name)}";`);
    }
    if (options.note !== undefined) {
      updates.push(`task.note = "${this.escapeString(options.note)}";`);
    }
    if (options.flagged !== undefined) {
      updates.push(`task.flagged = ${options.flagged};`);
    }
    if (options.completed !== undefined) {
      updates.push(options.completed ? 'task.markComplete();' : 'task.markIncomplete();');
    }
    if (options.estimatedMinutes !== undefined) {
      updates.push(`task.estimatedMinutes = ${options.estimatedMinutes};`);
    }
    if (options.defer !== undefined) {
      updates.push(
        options.defer
          ? `task.deferDate = new Date(${JSON.stringify(this.isoDateArg(options.defer, 'defer'))});`
          : 'task.deferDate = null;'
      );
    }
    if (options.due !== undefined) {
      updates.push(
        options.due
          ? `task.dueDate = new Date(${JSON.stringify(this.isoDateArg(options.due, 'due'))});`
          : 'task.dueDate = null;'
      );
    }
    if (options.planned !== undefined) {
      updates.push(
        options.planned
          ? `task.plannedDate = new Date(${JSON.stringify(this.isoDateArg(options.planned, 'planned'))});`
          : 'task.plannedDate = null;'
      );
    }
    if (options.sequential !== undefined) {
      updates.push(`task.sequential = ${options.sequential};`);
    }
    if (options.completedByChildren !== undefined) {
      updates.push(`task.completedByChildren = ${options.completedByChildren};`);
    }
    if (options.project !== undefined && options.project) {
      updates.push(`
        const targetProject = findProject("${this.escapeString(options.project)}");
        moveTasks([task], targetProject);
      `);
    }
    if (options.parent !== undefined && options.parent) {
      // Reparent: moving a task onto another task makes it a child of it.
      updates.push(`
        const newParent = findTask("${this.escapeString(options.parent)}");
        moveTasks([task], newParent);
      `);
    }
    if (options.tags !== undefined) {
      updates.push(`replaceTagsOn(task, ${JSON.stringify(options.tags)});`);
    }

    return updates.join('\n    ');
  }

  private buildTagUpdates(options: UpdateTagOptions): string {
    const updates: string[] = [];

    if (options.name !== undefined) {
      updates.push(`tag.name = "${this.escapeString(options.name)}";`);
    }
    if (options.status !== undefined) {
      updates.push(`tag.status = stringToTagStatus("${this.escapeString(options.status)}");`);
    }

    return updates.join('\n    ');
  }

  private buildProjectUpdates(options: UpdateProjectOptions): string {
    const updates: string[] = [];

    if (options.name !== undefined) {
      updates.push(`project.name = "${this.escapeString(options.name)}";`);
    }
    if (options.note !== undefined) {
      updates.push(`project.note = "${this.escapeString(options.note)}";`);
    }
    if (options.sequential !== undefined) {
      updates.push(`project.sequential = ${options.sequential};`);
    }
    if (options.status !== undefined) {
      updates.push(
        `project.status = stringToProjectStatus("${this.escapeString(options.status)}");`
      );
    }
    if (options.folder !== undefined && options.folder) {
      updates.push(`
        const targetFolder = findFolder("${this.escapeString(options.folder)}");
        moveSections([project], targetFolder);
      `);
    }
    if (options.tags !== undefined) {
      updates.push(`replaceTagsOn(project, ${JSON.stringify(options.tags)});`);
    }
    if (options.reviewInterval !== undefined) {
      updates.push(this.reviewIntervalCode(options.reviewInterval));
    }

    return updates.join('\n    ');
  }

  /**
   * Parse a human review interval like "1 week" or "2 months" into the
   * {steps, unit} shape Project.ReviewInterval expects.
   */
  private parseReviewInterval(value: string): { steps: number; unit: string } {
    const match = value.trim().match(/^(\d+)\s*(day|week|month|year)s?$/i);
    if (!match) {
      throw new OmniFocusCliError(
        `Invalid review interval: "${value}" (expected e.g. "1 week", "2 months")`,
        400
      );
    }
    return { steps: Number.parseInt(match[1], 10), unit: `${match[2].toLowerCase()}s` };
  }

  /**
   * Project.ReviewInterval is a value object, not a proxy: mutate a copy and
   * assign it back (per the Omni Automation docs) — property writes on the
   * live value would silently do nothing.
   *
   * project.reviewInterval is documented as "Project.ReviewInterval or null"
   * (a project with no review schedule configured), and there is no public
   * constructor for the value object — `new Project.ReviewInterval()` throws
   * "CallbackObject is not a constructor", and assigning a plain {steps,
   * unit} literal is rejected with a type error, both confirmed live against
   * OmniFocus 4.8.12. So when reviewInterval is null there is no way to
   * build one from scratch; guard and fail with a clear, actionable message
   * instead of letting `ri.steps = …` throw a bare "null is not an object"
   * from deep inside the generated script.
   */
  private reviewIntervalCode(value: string): string {
    const { steps, unit } = this.parseReviewInterval(value);
    return `
        const ri = project.reviewInterval;
        if (!ri) {
          throw new Error(
            "Project has no review interval configured; set one from the OmniFocus UI " +
            "(Project Inspector > Review) before updating it via the CLI."
          );
        }
        ri.steps = ${steps};
        ri.unit = "${unit}";
        project.reviewInterval = ri;
      `;
  }

  async listTasks(filters: TaskFilters = {}): Promise<Task[]> {
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        const results = [];
        for (const task of flattenedTasks) {
          ${this.buildTaskFilters(filters)}
          results.push(serializeTask(task));
        }
        return JSON.stringify(results);
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  async createTask(options: CreateTaskOptions): Promise<Task> {
    if (options.project && options.parent) {
      throw new OmniFocusCliError(
        'Cannot set both project and parent: a child task inherits its project from the parent task',
        400
      );
    }
    // Passing a Task as the position parents the new task under it (action group).
    const construction = options.parent
      ? `const parentTask = findTask("${this.escapeString(options.parent)}");
             const task = new Task("${this.escapeString(options.name)}", parentTask);`
      : options.project
        ? `const targetProject = findProject("${this.escapeString(options.project)}");
             const task = new Task("${this.escapeString(options.name)}", targetProject);`
        : `const task = new Task("${this.escapeString(options.name)}");`;
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        ${construction}

        ${options.note ? `task.note = "${this.escapeString(options.note)}";` : ''}
        ${options.flagged ? 'task.flagged = true;' : ''}
        ${options.estimatedMinutes != null ? `task.estimatedMinutes = ${options.estimatedMinutes};` : ''}
        ${options.defer ? `task.deferDate = new Date(${JSON.stringify(options.defer)});` : ''}
        ${options.due ? `task.dueDate = new Date(${JSON.stringify(options.due)});` : ''}
        ${options.planned ? `task.plannedDate = new Date(${JSON.stringify(options.planned)});` : ''}
        ${options.tags && options.tags.length > 0 ? `assignTags(task, ${JSON.stringify(options.tags)});` : ''}

        return JSON.stringify(serializeTask(task));
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  async updateTask(idOrName: string, options: UpdateTaskOptions): Promise<Task> {
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        const task = findTask("${this.escapeString(idOrName)}");
        ${this.buildTaskUpdates(options)}
        return JSON.stringify(serializeTask(task));
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  async deleteTask(idOrName: string): Promise<void> {
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        deleteObject(findTask("${this.escapeString(idOrName)}"));
      })();
    `;

    await this.executeJXA(this.wrapOmniScript(omniScript));
  }

  /**
   * GTD-style drop: abandon the task while keeping its history (unlike
   * deleteTask). allOccurrences=true also kills future repeats; false drops
   * just this occurrence of a repeating task.
   */
  async dropTask(idOrName: string, opts: { allOccurrences?: boolean } = {}): Promise<Task> {
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        const task = findTask("${this.escapeString(idOrName)}");
        task.drop(${opts.allOccurrences === true});
        return JSON.stringify(serializeTask(task));
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  async listProjects(filters: ProjectFilters = {}): Promise<Project[]> {
    const filterCode = this.buildProjectFilters(filters);
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        const results = [];
        for (const project of flattenedProjects) {
          ${filterCode}
          results.push(serializeProject(project));
        }
        return JSON.stringify(results);
      })();
    `;
    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  async createProject(options: CreateProjectOptions): Promise<Project> {
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        ${
          options.folder
            ? `const targetFolder = findFolder("${this.escapeString(options.folder)}");
             const project = new Project("${this.escapeString(options.name)}", targetFolder);`
            : `const project = new Project("${this.escapeString(options.name)}");`
        }

        ${options.note ? `project.note = "${this.escapeString(options.note)}";` : ''}
        ${options.sequential !== undefined ? `project.sequential = ${options.sequential};` : ''}
        ${options.status ? `project.status = stringToProjectStatus("${this.escapeString(options.status)}");` : ''}
        ${options.tags && options.tags.length > 0 ? `assignTags(project, ${JSON.stringify(options.tags)});` : ''}
        ${options.reviewInterval !== undefined ? this.reviewIntervalCode(options.reviewInterval) : ''}

        return JSON.stringify(serializeProject(project));
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  async updateProject(idOrName: string, options: UpdateProjectOptions): Promise<Project> {
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        const project = findProject("${this.escapeString(idOrName)}");
        ${this.buildProjectUpdates(options)}
        return JSON.stringify(serializeProject(project));
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  async deleteProject(idOrName: string): Promise<void> {
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        deleteObject(findProject("${this.escapeString(idOrName)}"));
      })();
    `;

    await this.executeJXA(this.wrapOmniScript(omniScript));
  }

  // Inbox tools use the headless `inbox` global (root inbox items) rather
  // than traversing the Inbox perspective, which needed an open OmniFocus
  // window and paid a perspective-switch delay.
  //
  // The `inbox` global retains completed and dropped root items (verified on
  // OmniFocus 4.8.12), whereas the old Inbox-perspective count only surfaced
  // active, incomplete ones. Both tools therefore apply the same filter the
  // rest of the codebase uses so the list and the count always agree: skip
  // completed tasks (task.completed) and dropped tasks (!task.effectiveActive).
  // Note effectiveActive is true for completed tasks, so both checks are
  // required — !effectiveActive alone would still count completed items.
  async listInboxTasks(): Promise<Task[]> {
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        const results = [];
        for (const task of inbox) {
          if (task.completed) continue;
          if (!task.effectiveActive) continue;
          results.push(serializeTask(task));
        }
        return JSON.stringify(results);
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  async getInboxCount(): Promise<number> {
    const omniScript = `
      (() => {
        let count = 0;
        for (const task of inbox) {
          if (task.completed) continue;
          if (!task.effectiveActive) continue;
          count++;
        }
        return JSON.stringify({ count });
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output).count;
  }

  async searchTasks(query: string): Promise<Task[]> {
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        const results = [];
        const searchQuery = "${this.escapeString(query)}".toLowerCase();

        for (const task of flattenedTasks) {
          if (task.completed) continue;
          if (!task.effectiveActive) continue;

          const name = task.name.toLowerCase();
          const note = (task.note || '').toLowerCase();

          if (name.includes(searchQuery) || note.includes(searchQuery)) {
            results.push(serializeTask(task));
          }
        }

        return JSON.stringify(results);
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  async getTask(idOrName: string, options: GetTaskOptions = {}): Promise<Task> {
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        const task = findTask("${this.escapeString(idOrName)}");
        const result = serializeTask(task);
        ${options.includeChildren ? 'result.children = task.children.map(c => serializeTask(c));' : ''}
        return JSON.stringify(result);
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  async getProject(idOrName: string): Promise<Project> {
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        const project = findProject("${this.escapeString(idOrName)}");
        return JSON.stringify(serializeProject(project));
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  async listPerspectives(): Promise<Perspective[]> {
    const omniScript = `
      (() => {
        const results = [];

        const builtInNames = ['Inbox', 'Flagged', 'Forecast', 'Projects', 'Tags', 'Nearby', 'Review'];
        for (const name of builtInNames) {
          results.push({ id: name, name: name });
        }

        const customPerspectives = Perspective.Custom.all;
        for (const perspective of customPerspectives) {
          results.push({ id: perspective.name, name: perspective.name });
        }

        return JSON.stringify(results);
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  async getPerspectiveTasks(
    perspectiveName: string,
    opts: { signal?: AbortSignal } = {}
  ): Promise<Task[]> {
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        const doc = document;
        const windows = doc.windows;

        if (windows.length === 0) {
          throw new Error("No OmniFocus window is open. Please open an OmniFocus window and try again.");
        }

        const win = windows[0];
        const perspectiveName = "${this.escapeString(perspectiveName)}";

        const builtInPerspectives = {
          'inbox': Perspective.BuiltIn.Inbox,
          'flagged': Perspective.BuiltIn.Flagged,
          'forecast': Perspective.BuiltIn.Forecast,
          'projects': Perspective.BuiltIn.Projects,
          'tags': Perspective.BuiltIn.Tags,
          'nearby': Perspective.BuiltIn.Nearby,
          'review': Perspective.BuiltIn.Review
        };

        const lowerName = perspectiveName.toLowerCase();
        if (builtInPerspectives[lowerName]) {
          win.perspective = builtInPerspectives[lowerName];
        } else {
          const customPerspective = Perspective.Custom.byName(perspectiveName);
          if (customPerspective) {
            win.perspective = customPerspective;
          } else {
            throw new Error("Perspective not found: " + perspectiveName);
          }
        }

        const content = win.content;
        if (!content) {
          throw new Error("No content available in window");
        }

        const tasks = [];
        content.rootNode.apply(node => {
          const obj = node.object;
          if (obj instanceof Task) {
            tasks.push(serializeTask(obj));
          }
        });

        return JSON.stringify(tasks);
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript), {
      timeoutMs: 60000,
      signal: opts.signal,
    });
    return JSON.parse(output);
  }

  async listTags(options: TagListOptions = {}): Promise<Tag[]> {
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        const results = [];
        const now = new Date();
        const activeOnly = ${!!options.activeOnly};

        for (const tag of flattenedTags) {
          const serialized = serializeTag(tag, activeOnly);
          results.push(serialized);
        }

        ${
          options.unusedDays
            ? `
          const cutoffDate = new Date(now.getTime() - (${options.unusedDays} * 24 * 60 * 60 * 1000));
          const filtered = results.filter(tag => {
            if (!tag.lastActivity) return true;
            return new Date(tag.lastActivity) < cutoffDate;
          });
          return JSON.stringify(filtered);
        `
            : 'return JSON.stringify(results);'
        }
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    const tags = JSON.parse(output);

    return this.sortTags(tags, options.sortBy);
  }

  private sortTags(tags: Tag[], sortBy: string = 'name'): Tag[] {
    const sortFns: Record<string, (a: Tag, b: Tag) => number> = {
      usage: (a, b) => b.taskCount - a.taskCount,
      activity: (a, b) => {
        if (!a.lastActivity && !b.lastActivity) return 0;
        if (!a.lastActivity) return 1;
        if (!b.lastActivity) return -1;
        return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
      },
      name: (a, b) => a.name.localeCompare(b.name),
    };

    return tags.sort(sortFns[sortBy] || sortFns.name);
  }

  async getTagStats(): Promise<TagStats> {
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        const allTags = [];
        for (const tag of flattenedTags) {
          allTags.push(serializeTag(tag));
        }

        const activeTags = allTags.filter(t => t.active);
        const tagsWithTasks = allTags.filter(t => t.taskCount > 0);
        const unusedTags = allTags.filter(t => t.taskCount === 0);

        const totalTasks = tagsWithTasks.reduce((sum, t) => sum + t.taskCount, 0);
        const avgTasksPerTag = computeAverage(totalTasks, tagsWithTasks.length);

        const mostUsedTags = computeTopItems(allTags, 'taskCount');
        const leastUsedTags = computeTopItems(
          tagsWithTasks.map(t => ({ ...t, taskCount: -t.taskCount })),
          'taskCount'
        ).map(t => ({ name: t.name, taskCount: -t.taskCount }));

        const now = new Date();
        const thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));
        const staleTags = allTags
          .filter(t => t.lastActivity && new Date(t.lastActivity) < thirtyDaysAgo)
          .map(t => ({
            name: t.name,
            daysSinceActivity: Math.floor((now - new Date(t.lastActivity)) / (24 * 60 * 60 * 1000))
          }))
          .sort((a, b) => b.daysSinceActivity - a.daysSinceActivity);

        return JSON.stringify({
          totalTags: allTags.length,
          activeTags: activeTags.length,
          tagsWithTasks: tagsWithTasks.length,
          unusedTags: unusedTags.length,
          avgTasksPerTag,
          mostUsedTags,
          leastUsedTags,
          staleTags
        });
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  async createTag(options: CreateTagOptions): Promise<Tag> {
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        ${
          options.parent
            ? `const parentTag = findTag("${this.escapeString(options.parent)}");
             const tag = new Tag("${this.escapeString(options.name)}", parentTag);`
            : `const tag = new Tag("${this.escapeString(options.name)}", tags.beginning);`
        }

        ${options.status ? `tag.status = stringToTagStatus("${this.escapeString(options.status)}");` : ''}

        return JSON.stringify(serializeTag(tag));
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  async getTag(idOrName: string): Promise<Tag> {
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        const tag = findTag("${this.escapeString(idOrName)}");
        return JSON.stringify(serializeTag(tag));
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  async updateTag(idOrName: string, options: UpdateTagOptions): Promise<Tag> {
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        const tag = findTag("${this.escapeString(idOrName)}");
        ${this.buildTagUpdates(options)}
        return JSON.stringify(serializeTag(tag));
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  async deleteTag(idOrName: string): Promise<void> {
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        deleteObject(findTag("${this.escapeString(idOrName)}"));
      })();
    `;

    await this.executeJXA(this.wrapOmniScript(omniScript));
  }

  async getTaskStats(): Promise<TaskStats> {
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        const allTasks = Array.from(flattenedTasks);
        const now = new Date();

        const activeTasks = allTasks.filter(t => !t.completed && t.effectiveActive);
        const completedTasks = allTasks.filter(t => t.completed);
        const flaggedTasks = activeTasks.filter(t => t.flagged);
        const overdueActiveTasks = activeTasks.filter(t => t.dueDate && t.dueDate < now);

        const tasksWithEstimates = allTasks.filter(t => t.estimatedMinutes && t.estimatedMinutes > 0);
        const totalEstimatedMinutes = tasksWithEstimates.reduce((sum, t) => sum + (t.estimatedMinutes || 0), 0);
        const avgEstimatedMinutes = tasksWithEstimates.length > 0
          ? Math.round(totalEstimatedMinutes / tasksWithEstimates.length)
          : null;

        const totalNonDropped = allTasks.filter(t => t.effectiveActive || t.completed).length;
        const completionRate = totalNonDropped > 0
          ? Math.round((completedTasks.length / totalNonDropped) * 100)
          : 0;

        const projectCounts = {};
        for (const task of allTasks) {
          if (!task.effectiveActive && !task.completed) continue;
          const projectName = task.containingProject ? task.containingProject.name : 'Inbox';
          projectCounts[projectName] = (projectCounts[projectName] || 0) + 1;
        }
        const tasksByProject = computeTopItems(
          Object.entries(projectCounts).map(([name, count]) => ({ name, taskCount: count })),
          'taskCount'
        );

        const tagCounts = {};
        for (const task of allTasks) {
          if (!task.effectiveActive && !task.completed) continue;
          for (const tag of task.tags) {
            tagCounts[tag.name] = (tagCounts[tag.name] || 0) + 1;
          }
        }
        const tasksByTag = computeTopItems(
          Object.entries(tagCounts).map(([name, count]) => ({ name, taskCount: count })),
          'taskCount'
        );

        return JSON.stringify({
          totalTasks: allTasks.length,
          activeTasks: activeTasks.length,
          completedTasks: completedTasks.length,
          flaggedTasks: flaggedTasks.length,
          overdueActiveTasks: overdueActiveTasks.length,
          avgEstimatedMinutes,
          tasksWithEstimates: tasksWithEstimates.length,
          completionRate,
          tasksByProject,
          tasksByTag
        });
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  async getProjectStats(): Promise<ProjectStats> {
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        const allProjects = Array.from(flattenedProjects);

        function isProjectEffectivelyActive(p) {
          if (p.status === Project.Status.Dropped || p.status === Project.Status.Done) return false;
          if (p.parentFolder && !p.parentFolder.effectiveActive) return false;
          return true;
        }

        const effectivelyActiveProjects = allProjects.filter(isProjectEffectivelyActive);
        const activeProjects = effectivelyActiveProjects.filter(p => p.status === Project.Status.Active);
        const onHoldProjects = effectivelyActiveProjects.filter(p => p.status === Project.Status.OnHold);
        const droppedProjects = allProjects.filter(p => p.status === Project.Status.Dropped);
        const doneProjects = allProjects.filter(p => p.status === Project.Status.Done);
        const sequentialProjects = effectivelyActiveProjects.filter(p => p.sequential);
        const parallelProjects = effectivelyActiveProjects.filter(p => !p.sequential);

        const totalTasks = effectivelyActiveProjects.reduce((sum, p) => sum + p.flattenedTasks.length, 0);
        const totalRemaining = effectivelyActiveProjects.reduce((sum, p) => {
          return sum + p.flattenedTasks.filter(t => !t.completed).length;
        }, 0);

        const avgTasksPerProject = computeAverage(totalTasks, effectivelyActiveProjects.length);
        const avgRemainingPerProject = computeAverage(totalRemaining, effectivelyActiveProjects.length);

        const completionRates = effectivelyActiveProjects
          .filter(p => p.flattenedTasks.length > 0)
          .map(p => {
            const total = p.flattenedTasks.length;
            const completed = p.flattenedTasks.filter(t => t.completed).length;
            return (completed / total) * 100;
          });

        const avgCompletionRate = completionRates.length > 0
          ? Math.round(completionRates.reduce((sum, rate) => sum + rate, 0) / completionRates.length)
          : 0;

        const projectsWithMostTasks = computeTopItems(
          effectivelyActiveProjects.map(p => ({ name: p.name, taskCount: p.flattenedTasks.length })),
          'taskCount'
        );

        const projectsWithMostRemaining = computeTopItems(
          effectivelyActiveProjects
            .map(p => ({ name: p.name, remainingCount: p.flattenedTasks.filter(t => !t.completed).length }))
            .filter(p => p.remainingCount > 0),
          'remainingCount'
        );

        return JSON.stringify({
          totalProjects: allProjects.length,
          activeProjects: activeProjects.length,
          onHoldProjects: onHoldProjects.length,
          droppedProjects: droppedProjects.length,
          doneProjects: doneProjects.length,
          sequentialProjects: sequentialProjects.length,
          parallelProjects: parallelProjects.length,
          avgTasksPerProject,
          avgRemainingPerProject,
          avgCompletionRate,
          projectsWithMostTasks,
          projectsWithMostRemaining
        });
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  async listFolders(filters: FolderFilters = {}): Promise<Folder[]> {
    const includeDropped = filters.includeDropped ?? false;
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        const includeDropped = ${includeDropped};
        const results = [];
        for (const folder of folders) {
          if (!includeDropped && !folder.effectiveActive) continue;
          results.push(serializeFolder(folder, includeDropped));
        }
        return JSON.stringify(results);
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  async getFolder(idOrName: string, filters: FolderFilters = {}): Promise<Folder> {
    const includeDropped = filters.includeDropped ?? false;
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        const includeDropped = ${includeDropped};
        const folder = findFolder("${this.escapeString(idOrName)}");
        return JSON.stringify(serializeFolder(folder, includeDropped));
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  /**
   * Complete (or un-complete) a project via markComplete/markIncomplete
   * rather than raw status assignment — markComplete correctly handles
   * repeating projects by cloning and completing the clone.
   */
  async completeProject(idOrName: string, options: CompleteProjectOptions = {}): Promise<Project> {
    const action = options.incomplete
      ? 'project.markIncomplete();'
      : options.date
        ? `project.markComplete(new Date(${JSON.stringify(this.isoDateArg(options.date, 'completion'))}));`
        : 'project.markComplete();';
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        const project = findProject("${this.escapeString(idOrName)}");
        ${action}
        return JSON.stringify(serializeProject(project));
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  /**
   * Projects whose next review is due (nextReviewDate <= now). Headless: the
   * Review perspective is never touched — this queries flattenedProjects.
   * Dropped and completed projects are excluded; they aren't reviewed.
   */
  async listProjectsDueForReview(): Promise<Project[]> {
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        const now = new Date();
        const results = [];
        for (const project of flattenedProjects) {
          if (project.status === Project.Status.Dropped || project.status === Project.Status.Done) continue;
          if (project.parentFolder && !project.parentFolder.effectiveActive) continue;
          const next = project.nextReviewDate;
          if (!next || next > now) continue;
          results.push(serializeProject(project));
        }
        return JSON.stringify(results);
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  /**
   * Mark a project reviewed now: sets lastReviewDate, from which OmniFocus
   * recomputes nextReviewDate using the project's review interval.
   */
  async markProjectReviewed(idOrName: string): Promise<Project> {
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        const project = findProject("${this.escapeString(idOrName)}");
        project.lastReviewDate = new Date();
        return JSON.stringify(serializeProject(project));
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  /**
   * Emit the date-shift statements for a batch update. Each shift reads the
   * task's current date, adds N days (negative pulls earlier), and writes it
   * back; tasks lacking that date are skipped rather than failed.
   */
  private buildDateShifts(options: UpdateTasksOptions): string {
    const shifts: Array<[number | undefined, string, string]> = [
      [options.shiftDueDays, 'shiftDueDays', 'dueDate'],
      [options.shiftDeferDays, 'shiftDeferDays', 'deferDate'],
      [options.shiftPlannedDays, 'shiftPlannedDays', 'plannedDate'],
    ];
    const code: string[] = [];
    for (const [days, optionName, property] of shifts) {
      if (days === undefined) continue;
      if (!Number.isInteger(days)) {
        throw new OmniFocusCliError(`Invalid ${optionName}: ${days} (expected an integer)`, 400);
      }
      code.push(
        `{ const d = task.${property}; if (d) { d.setDate(d.getDate() + ${days}); task.${property} = d; } }`
      );
    }
    return code.join('\n          ');
  }

  /**
   * Apply the same updates to many tasks in a single osascript round trip.
   * Returns a per-id result array; an unresolved id records an error entry
   * instead of aborting the whole batch.
   */
  async updateTasks(ids: string[], options: UpdateTasksOptions = {}): Promise<BatchUpdateResult[]> {
    if (ids.length === 0) {
      throw new OmniFocusCliError('No task ids given', 400);
    }
    const { shiftDueDays, shiftDeferDays, shiftPlannedDays, ...updates } = options;
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        const ids = ${JSON.stringify(ids)};
        const results = [];
        for (const id of ids) {
          try {
            const task = findTask(id);
            ${this.buildTaskUpdates(updates)}
            ${this.buildDateShifts({ shiftDueDays, shiftDeferDays, shiftPlannedDays })}
            results.push({ id: id, ok: true, task: serializeTask(task) });
          } catch (e) {
            results.push({ id: id, ok: false, error: e instanceof Error ? e.message : String(e) });
          }
        }
        return JSON.stringify(results);
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  /** Fuzzy project search with Quick Open semantics (projectsMatching). */
  async searchProjects(query: string): Promise<Project[]> {
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        const matches = projectsMatching("${this.escapeString(query)}");
        return JSON.stringify(matches.map(p => serializeProject(p)));
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  /** Fuzzy tag search with Quick Open semantics (tagsMatching). */
  async searchTags(query: string): Promise<Tag[]> {
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        const matches = tagsMatching("${this.escapeString(query)}");
        return JSON.stringify(matches.map(t => serializeTag(t)));
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  /** Fuzzy folder search with Quick Open semantics (foldersMatching). */
  async searchFolders(query: string): Promise<Folder[]> {
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        const matches = foldersMatching("${this.escapeString(query)}");
        return JSON.stringify(matches.map(f => serializeFolder(f)));
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  /**
   * Process the inbox: optionally give unassigned inbox tasks a tentative
   * container (assignedContainer), then run Database.cleanUp() so OmniFocus
   * files them. Without a container this just runs cleanUp(), which also
   * refreshes stale tag/task membership.
   */
  async cleanupInbox(options: { container?: string } = {}): Promise<CleanupInboxResult> {
    const assignCode = options.container
      ? `
        const target = findProject("${this.escapeString(options.container)}");
        for (const task of inbox) {
          if (task.assignedContainer === null) {
            task.assignedContainer = target;
            assigned += 1;
          }
        }`
      : '';
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        const before = inbox.length;
        let assigned = 0;
        ${assignCode}
        cleanUp();
        return JSON.stringify({ inboxBefore: before, assigned: assigned, inboxAfter: inbox.length });
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  /**
   * Undo the last change in OmniFocus. Undo granularity is OmniFocus's own
   * action grouping: one evaluateJavascript script is typically one undo
   * group, so this is a clean escape hatch after a batch operation.
   */
  async undo(): Promise<{ undone: boolean }> {
    const omniScript = `
      (() => {
        if (!canUndo) {
          throw new Error("Nothing to undo");
        }
        undo();
        return JSON.stringify({ undone: true });
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  async redo(): Promise<{ redone: boolean }> {
    const omniScript = `
      (() => {
        if (!canRedo) {
          throw new Error("Nothing to redo");
        }
        redo();
        return JSON.stringify({ redone: true });
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  /** Save the database; when sync is enabled this also triggers a sync. */
  async syncNow(): Promise<{ saved: boolean }> {
    const omniScript = `
      (() => {
        save();
        return JSON.stringify({ saved: true });
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  async createFolder(options: CreateFolderOptions): Promise<Folder> {
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        ${
          options.parent
            ? `const parentFolder = findFolder("${this.escapeString(options.parent)}");
             const folder = new Folder("${this.escapeString(options.name)}", parentFolder);`
            : `const folder = new Folder("${this.escapeString(options.name)}");`
        }
        return JSON.stringify(serializeFolder(folder));
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  private buildFolderUpdates(options: UpdateFolderOptions): string {
    const updates: string[] = [];

    if (options.name !== undefined) {
      updates.push(`folder.name = "${this.escapeString(options.name)}";`);
    }
    if (options.status !== undefined) {
      updates.push(`folder.status = stringToFolderStatus("${this.escapeString(options.status)}");`);
    }
    if (options.parent !== undefined && options.parent) {
      updates.push(`
        const destFolder = findFolder("${this.escapeString(options.parent)}");
        moveSections([folder], destFolder);
      `);
    }

    return updates.join('\n    ');
  }

  async updateFolder(idOrName: string, options: UpdateFolderOptions): Promise<Folder> {
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        const folder = findFolder("${this.escapeString(idOrName)}");
        ${this.buildFolderUpdates(options)}
        return JSON.stringify(serializeFolder(folder));
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  async deleteFolder(idOrName: string): Promise<void> {
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        deleteObject(findFolder("${this.escapeString(idOrName)}"));
      })();
    `;

    await this.executeJXA(this.wrapOmniScript(omniScript));
  }

  /**
   * Promote a task to a project (Database.convertTasksToProjects). Child
   * tasks come along; the new project lands in the given folder or at the
   * end of the library.
   */
  async convertTaskToProject(
    idOrName: string,
    options: ConvertTaskToProjectOptions = {}
  ): Promise<Project> {
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        const task = findTask("${this.escapeString(idOrName)}");
        ${
          options.folder
            ? `const destination = findFolder("${this.escapeString(options.folder)}");`
            : 'const destination = library.ending;'
        }
        const newProjects = convertTasksToProjects([task], destination);
        return JSON.stringify(serializeProject(newProjects[0]));
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  /**
   * Set (or clear) a task's repeat pattern using the OmniFocus 4.7+ five-arg
   * RepetitionRule constructor. An invalid ICS rule string throws inside
   * OmniFocus and surfaces as a clean error.
   */
  async setTaskRepeat(idOrName: string, options: SetTaskRepeatOptions): Promise<Task> {
    let action: string;
    if (options.clear) {
      if (options.rule !== undefined) {
        throw new OmniFocusCliError('Cannot combine clear with a rule', 400);
      }
      action = 'task.repetitionRule = null;';
    } else {
      if (!options.rule) {
        throw new OmniFocusCliError(
          'A rule is required unless clearing (e.g. "FREQ=WEEKLY;BYDAY=MO")',
          400
        );
      }
      const scheduleEnum = { regularly: 'Regularly', fromCompletion: 'FromCompletion' }[
        options.schedule ?? 'regularly'
      ];
      const anchorEnum = { deferDate: 'DeferDate', dueDate: 'DueDate', plannedDate: 'PlannedDate' }[
        options.anchor ?? 'dueDate'
      ];
      if (!scheduleEnum) {
        throw new OmniFocusCliError(
          `Invalid schedule: "${options.schedule}" (expected regularly or fromCompletion)`,
          400
        );
      }
      if (!anchorEnum) {
        throw new OmniFocusCliError(
          `Invalid anchor: "${options.anchor}" (expected dueDate, deferDate, or plannedDate)`,
          400
        );
      }
      // The second (method) argument is the deprecated pre-4.7 form and must
      // be null when scheduleType/anchorDateKey are given.
      action = `task.repetitionRule = new Task.RepetitionRule("${this.escapeString(options.rule)}", null, Task.RepetitionScheduleType.${scheduleEnum}, Task.AnchorDateKey.${anchorEnum}, ${options.catchUp === true});`;
    }

    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        const task = findTask("${this.escapeString(idOrName)}");
        ${action}
        return JSON.stringify(serializeTask(task));
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  /**
   * Emit script code resolving a MoveTaskOptions destination to a `position`
   * usable by moveTasks/duplicateTasks. Exactly one destination is allowed:
   * project | parentTask | inbox (each with an optional beginning/end
   * position, default end), or a before/after sibling position alone (the
   * sibling implies the container).
   */
  private taskPositionCode(options: MoveTaskOptions): string {
    const position = options.position;
    const relative = typeof position === 'object' && position !== null ? position : undefined;
    const destinations = [
      options.project !== undefined,
      options.parentTask !== undefined,
      options.inbox === true,
      relative !== undefined,
    ].filter(Boolean).length;
    if (destinations !== 1) {
      throw new OmniFocusCliError(
        'Specify exactly one destination: project, parentTask, inbox, or a before/after position',
        400
      );
    }
    if (relative) {
      if ('before' in relative) {
        return `const position = findTask("${this.escapeString(relative.before)}").before;`;
      }
      return `const position = findTask("${this.escapeString(relative.after)}").after;`;
    }
    // Container destinations: beginning or ending (the API's name for "end").
    const edge = position === 'beginning' ? 'beginning' : 'ending';
    if (options.project !== undefined) {
      return `const position = findProject("${this.escapeString(options.project)}").${edge};`;
    }
    if (options.parentTask !== undefined) {
      return `const position = findTask("${this.escapeString(options.parentTask)}").${edge};`;
    }
    return `const position = inbox.${edge};`;
  }

  /**
   * Move a task to a project, under a parent task, to the inbox, or to a
   * position relative to a sibling. Returns the task reserialized in place.
   */
  async moveTask(idOrName: string, options: MoveTaskOptions): Promise<Task> {
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        const task = findTask("${this.escapeString(idOrName)}");
        ${this.taskPositionCode(options)}
        moveTasks([task], position);
        return JSON.stringify(serializeTask(task));
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  /**
   * Duplicate a task (children come along) to the same destinations moveTask
   * accepts; with no destination the copy lands right after the original.
   * Returns the new task.
   */
  async duplicateTask(idOrName: string, options: MoveTaskOptions = {}): Promise<Task> {
    const hasDestination =
      options.project !== undefined ||
      options.parentTask !== undefined ||
      options.inbox === true ||
      options.position !== undefined;
    const positionCode = hasDestination
      ? this.taskPositionCode(options)
      : 'const position = task.after;';
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        const task = findTask("${this.escapeString(idOrName)}");
        ${positionCode}
        const newTasks = duplicateTasks([task], position);
        return JSON.stringify(serializeTask(newTasks[0]));
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }

  /**
   * Create tasks from OmniFocus transport text (TaskPaper-style shorthand)
   * via Task.byParsingTransportText. Created tasks land in the inbox unless
   * a project is given, in which case they are moved there in the same
   * script. Returns the created tasks.
   */
  async parseTasks(text: string, options: ParseTasksOptions = {}): Promise<Task[]> {
    const moveCode = options.project
      ? `const targetProject = findProject("${this.escapeString(options.project)}");
        moveTasks(created, targetProject);`
      : '';
    const omniScript = `
      ${this.OMNI_HELPERS}
      (() => {
        const created = Task.byParsingTransportText("${this.escapeString(text)}", null);
        ${moveCode}
        return JSON.stringify(created.map(t => serializeTask(t)));
      })();
    `;

    const output = await this.executeJXA(this.wrapOmniScript(omniScript));
    return JSON.parse(output);
  }
}
