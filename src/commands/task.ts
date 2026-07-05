import { Command } from 'commander';
import { outputJson } from '../lib/output.js';
import { withErrorHandling } from '../lib/command-utils.js';
import { OmniFocus } from '../lib/omnifocus.js';
import { parseDateTime } from '../lib/dates.js';
import { OmniFocusCliError } from '../lib/errors.js';
import type {
  MoveTaskOptions,
  TaskFilters,
  TaskStatusFilter,
  UpdateTaskOptions,
  UpdateTasksOptions,
} from '../types.js';

/**
 * Map the shared move/duplicate CLI flags (--project/--parent/--inbox with
 * --position, or --before/--after) onto MoveTaskOptions. Destination
 * validation happens in the OmniFocus layer.
 */
function moveOptionsFromFlags(options: {
  project?: string;
  parent?: string;
  inbox?: boolean;
  position?: string;
  before?: string;
  after?: string;
}): MoveTaskOptions {
  if (options.position && options.position !== 'beginning' && options.position !== 'end') {
    throw new Error(`Invalid position "${options.position}". Valid: beginning, end`);
  }
  return {
    ...(options.project && { project: options.project }),
    ...(options.parent && { parentTask: options.parent }),
    ...(options.inbox && { inbox: true }),
    ...(options.position === 'beginning' && { position: 'beginning' as const }),
    ...(options.before && { position: { before: options.before } }),
    ...(options.after && { position: { after: options.after } }),
  };
}

const TASK_STATUS_FILTERS: TaskStatusFilter[] = [
  'actionable',
  'available',
  'next',
  'blocked',
  'dueSoon',
  'overdue',
  'completed',
  'dropped',
];

export function parseStatusFilter(value: string): TaskStatusFilter {
  if (!(TASK_STATUS_FILTERS as string[]).includes(value)) {
    // Throw the structured 400 (matching isoDateArg's invalid-date handling)
    // so a bad --status is classified as client error, not a generic 500.
    throw new OmniFocusCliError(
      `Invalid status "${value}". Valid: ${TASK_STATUS_FILTERS.join(', ')}`,
      400
    );
  }
  return value as TaskStatusFilter;
}

/**
 * Reject a pair of opposite boolean flags (--complete/--incomplete,
 * --flag/--unflag) when both are given: silently letting object-spread
 * order pick a winner means the "loses" flag does something invisible to
 * the caller. Called from the action handler so withErrorHandling turns
 * this into a clean JSON 400.
 */
function rejectConflictingFlags(
  pairs: Array<[boolean | undefined, boolean | undefined, string, string]>
): void {
  for (const [a, b, aName, bName] of pairs) {
    if (a && b) {
      throw new OmniFocusCliError(`Cannot combine ${aName} and ${bName}`, 400);
    }
  }
}

export function createTaskCommand(): Command {
  const command = new Command('task');
  command.description('Manage OmniFocus tasks');

  command
    .command('list')
    .alias('ls')
    .description('List tasks')
    .option('-f, --flagged', 'Show only flagged tasks')
    .option('-p, --project <name>', 'Filter by project')
    .option('-t, --tag <name>', 'Filter by tag')
    .option('-c, --completed', 'Include completed tasks')
    .option(
      '-s, --status <status>',
      `Filter by status (${TASK_STATUS_FILTERS.join('|')})`,
      parseStatusFilter
    )
    .option('--due-before <date>', 'Effective due date before (ISO 8601)')
    .option('--due-after <date>', 'Effective due date after (ISO 8601)')
    .option('--defer-before <date>', 'Effective defer date before (ISO 8601)')
    .option('--defer-after <date>', 'Effective defer date after (ISO 8601)')
    .option('--planned-before <date>', 'Planned date before (ISO 8601)')
    .option('--planned-after <date>', 'Planned date after (ISO 8601)')
    .option('--completed-before <date>', 'Completed before (ISO 8601; implies --completed)')
    .option('--completed-after <date>', 'Completed after (ISO 8601; implies --completed)')
    .option('--added-before <date>', 'Added before (ISO 8601)')
    .option('--added-after <date>', 'Added after (ISO 8601)')
    .action(
      withErrorHandling(async (options) => {
        const of = new OmniFocus();
        const filters: TaskFilters = {
          includeCompleted: options.completed,
          ...(options.flagged && { flagged: true }),
          ...(options.project && { project: options.project }),
          ...(options.tag && { tag: options.tag }),
          ...(options.status && { status: options.status }),
          ...(options.dueBefore && { dueBefore: parseDateTime(options.dueBefore) }),
          ...(options.dueAfter && { dueAfter: parseDateTime(options.dueAfter) }),
          ...(options.deferBefore && { deferBefore: parseDateTime(options.deferBefore) }),
          ...(options.deferAfter && { deferAfter: parseDateTime(options.deferAfter) }),
          ...(options.plannedBefore && { plannedBefore: parseDateTime(options.plannedBefore) }),
          ...(options.plannedAfter && { plannedAfter: parseDateTime(options.plannedAfter) }),
          ...(options.completedBefore && {
            completedBefore: parseDateTime(options.completedBefore),
          }),
          ...(options.completedAfter && { completedAfter: parseDateTime(options.completedAfter) }),
          ...(options.addedBefore && { addedBefore: parseDateTime(options.addedBefore) }),
          ...(options.addedAfter && { addedAfter: parseDateTime(options.addedAfter) }),
        };
        const tasks = await of.listTasks(filters);
        outputJson(tasks);
      })
    );

  command
    .command('create <name>')
    .description('Create a new task')
    .option('-p, --project <name>', 'Assign to project')
    .option(
      '--parent <idOrName>',
      'Create as a subtask of this task (mutually exclusive with --project)'
    )
    .option('--note <text>', 'Add note')
    .option('-t, --tag <tags...>', 'Add tags')
    .option('-d, --due <date>', 'Set due date')
    .option('-D, --defer <date>', 'Set defer date')
    .option('-P, --planned <date>', 'Set planned date')
    .option('-f, --flagged', 'Flag the task')
    .option('-e, --estimate <minutes>', 'Estimated time in minutes', parseInt)
    .action(
      withErrorHandling(async (name, options) => {
        const of = new OmniFocus();
        const task = await of.createTask({
          name,
          note: options.note,
          project: options.project,
          parent: options.parent,
          tags: options.tag,
          due: options.due ? parseDateTime(options.due) : undefined,
          defer: options.defer ? parseDateTime(options.defer) : undefined,
          planned: options.planned ? parseDateTime(options.planned) : undefined,
          flagged: options.flagged,
          estimatedMinutes: options.estimate,
        });
        outputJson(task);
      })
    );

  command
    .command('update <idOrName>')
    .description('Update an existing task')
    .option('-n, --name <name>', 'New name')
    .option('--note <text>', 'New note')
    .option('-p, --project <name>', 'Move to project')
    .option('--parent <idOrName>', 'Reparent under this task (mutually exclusive with --project)')
    .option('--sequential', 'Children must be completed in order')
    .option('--no-sequential', 'Children may be completed in any order (parallel)')
    .option('--completed-by-children', 'Auto-complete when the last child completes')
    .option('--no-completed-by-children', 'Do not auto-complete when children complete')
    .option('-t, --tag <tags...>', 'Replace tags')
    .option('-d, --due <date>', 'Set due date')
    .option('-D, --defer <date>', 'Set defer date')
    .option('-P, --planned <date>', 'Set planned date')
    .option('-f, --flag', 'Flag the task')
    .option('-F, --unflag', 'Unflag the task')
    .option('-c, --complete', 'Mark as completed')
    .option('-C, --incomplete', 'Mark as incomplete')
    .option('-e, --estimate <minutes>', 'Estimated time in minutes', parseInt)
    .action(
      withErrorHandling(async (idOrName, options) => {
        rejectConflictingFlags([
          [options.flag, options.unflag, '--flag', '--unflag'],
          [options.complete, options.incomplete, '--complete', '--incomplete'],
        ]);
        const of = new OmniFocus();
        const updates: UpdateTaskOptions = {
          ...(options.name && { name: options.name }),
          ...(options.note !== undefined && { note: options.note }),
          ...(options.project && { project: options.project }),
          ...(options.parent && { parent: options.parent }),
          ...(options.sequential !== undefined && { sequential: options.sequential }),
          ...(options.completedByChildren !== undefined && {
            completedByChildren: options.completedByChildren,
          }),
          ...(options.tag && { tags: options.tag }),
          ...(options.due !== undefined && {
            due: options.due ? parseDateTime(options.due) : null,
          }),
          ...(options.defer !== undefined && {
            defer: options.defer ? parseDateTime(options.defer) : null,
          }),
          ...(options.planned !== undefined && {
            planned: options.planned ? parseDateTime(options.planned) : null,
          }),
          ...(options.flag && { flagged: true }),
          ...(options.unflag && { flagged: false }),
          ...(options.complete && { completed: true }),
          ...(options.incomplete && { completed: false }),
          ...(options.estimate !== undefined && { estimatedMinutes: options.estimate }),
        };
        const task = await of.updateTask(idOrName, updates);
        outputJson(task);
      })
    );

  command
    .command('update-many <idOrNames...>')
    .description('Apply the same updates to many tasks in one OmniFocus round trip')
    .option('-n, --name <name>', 'New name (applied to every task)')
    .option('--note <text>', 'New note')
    .option('-p, --project <name>', 'Move to project')
    .option('-t, --tag <tags...>', 'Replace tags')
    .option('-d, --due <date>', 'Set due date')
    .option('-D, --defer <date>', 'Set defer date')
    .option('-P, --planned <date>', 'Set planned date')
    .option('-f, --flag', 'Flag the tasks')
    .option('-F, --unflag', 'Unflag the tasks')
    .option('-c, --complete', 'Mark as completed')
    .option('-C, --incomplete', 'Mark as incomplete')
    .option('-e, --estimate <minutes>', 'Estimated time in minutes', parseInt)
    .option(
      '--shift-due <days>',
      'Shift due dates by N days (use --shift-due=-2 to pull earlier)',
      parseInt
    )
    .option('--shift-defer <days>', 'Shift defer dates by N days', parseInt)
    .option('--shift-planned <days>', 'Shift planned dates by N days', parseInt)
    .action(
      withErrorHandling(async (idOrNames, options) => {
        rejectConflictingFlags([
          [options.flag, options.unflag, '--flag', '--unflag'],
          [options.complete, options.incomplete, '--complete', '--incomplete'],
        ]);
        const of = new OmniFocus();
        const updates: UpdateTasksOptions = {
          ...(options.name && { name: options.name }),
          ...(options.note !== undefined && { note: options.note }),
          ...(options.project && { project: options.project }),
          ...(options.tag && { tags: options.tag }),
          ...(options.due !== undefined && {
            due: options.due ? parseDateTime(options.due) : null,
          }),
          ...(options.defer !== undefined && {
            defer: options.defer ? parseDateTime(options.defer) : null,
          }),
          ...(options.planned !== undefined && {
            planned: options.planned ? parseDateTime(options.planned) : null,
          }),
          ...(options.flag && { flagged: true }),
          ...(options.unflag && { flagged: false }),
          ...(options.complete && { completed: true }),
          ...(options.incomplete && { completed: false }),
          ...(options.estimate !== undefined && { estimatedMinutes: options.estimate }),
          ...(options.shiftDue !== undefined && { shiftDueDays: options.shiftDue }),
          ...(options.shiftDefer !== undefined && { shiftDeferDays: options.shiftDefer }),
          ...(options.shiftPlanned !== undefined && { shiftPlannedDays: options.shiftPlanned }),
        };
        const results = await of.updateTasks(idOrNames, updates);
        outputJson(results);
      })
    );

  command
    .command('promote <idOrName>')
    .description('Convert a task into a project (child tasks come along)')
    .option('-f, --folder <name>', 'Destination folder (default: end of library)')
    .action(
      withErrorHandling(async (idOrName, options) => {
        const of = new OmniFocus();
        const project = await of.convertTaskToProject(idOrName, { folder: options.folder });
        outputJson(project);
      })
    );

  command
    .command('drop <idOrName>')
    .description('Drop a task (abandon it, keeping history — unlike delete)')
    .option('--all-occurrences', 'Also stop future repeats of a repeating task')
    .action(
      withErrorHandling(async (idOrName, options) => {
        const of = new OmniFocus();
        const task = await of.dropTask(idOrName, { allOccurrences: options.allOccurrences });
        outputJson(task);
      })
    );

  command
    .command('delete <idOrName>')
    .alias('rm')
    .description('Delete a task')
    .action(
      withErrorHandling(async (idOrName) => {
        const of = new OmniFocus();
        await of.deleteTask(idOrName);
        outputJson({ message: 'Task deleted successfully' });
      })
    );

  command
    .command('view <idOrName>')
    .description('View task details')
    .option('--children', 'Include one level of serialized child tasks')
    .action(
      withErrorHandling(async (idOrName, options) => {
        const of = new OmniFocus();
        const task = await of.getTask(idOrName, { includeChildren: options.children });
        outputJson(task);
      })
    );

  command
    .command('repeat <idOrName>')
    .description('Set or clear a task repeat pattern (ICS RRULE)')
    .option('-r, --rule <rrule>', 'ICS RRULE string, e.g. "FREQ=WEEKLY;BYDAY=MO"')
    .option(
      '-s, --schedule <type>',
      'Repeat schedule: regularly|fromCompletion (default regularly)'
    )
    .option('-a, --anchor <date>', 'Anchor date: dueDate|deferDate|plannedDate (default dueDate)')
    .option('--catch-up', 'Skip past occurrences when resolving (regular repeats only)')
    .option('--clear', 'Remove the repetition rule')
    .action(
      withErrorHandling(async (idOrName, options) => {
        const of = new OmniFocus();
        const task = await of.setTaskRepeat(idOrName, {
          rule: options.rule,
          schedule: options.schedule,
          anchor: options.anchor,
          catchUp: options.catchUp,
          clear: options.clear,
        });
        outputJson(task);
      })
    );

  command
    .command('move <idOrName>')
    .description('Move a task to a project, parent task, inbox, or relative to a sibling')
    .option('-p, --project <idOrName>', 'Destination project')
    .option('--parent <idOrName>', 'Destination parent task (makes it a subtask)')
    .option('--inbox', 'Move to the inbox')
    .option('--position <where>', 'beginning|end of the destination (default end)')
    .option('--before <idOrName>', 'Place just before this sibling task')
    .option('--after <idOrName>', 'Place just after this sibling task')
    .action(
      withErrorHandling(async (idOrName, options) => {
        const of = new OmniFocus();
        const task = await of.moveTask(idOrName, moveOptionsFromFlags(options));
        outputJson(task);
      })
    );

  command
    .command('duplicate <idOrName>')
    .description('Duplicate a task (children come along); defaults to just after the original')
    .option('-p, --project <idOrName>', 'Destination project')
    .option('--parent <idOrName>', 'Destination parent task')
    .option('--inbox', 'Duplicate into the inbox')
    .option('--position <where>', 'beginning|end of the destination (default end)')
    .option('--before <idOrName>', 'Place just before this sibling task')
    .option('--after <idOrName>', 'Place just after this sibling task')
    .action(
      withErrorHandling(async (idOrName, options) => {
        const of = new OmniFocus();
        const task = await of.duplicateTask(idOrName, moveOptionsFromFlags(options));
        outputJson(task);
      })
    );

  command
    .command('parse <text>')
    .description(
      'Create tasks from transport text: "Name! ::Project #defer #due $2h @tag //note" (-- starts another task)'
    )
    .option('-p, --project <idOrName>', 'Move the created tasks into this project')
    .action(
      withErrorHandling(async (text, options) => {
        const of = new OmniFocus();
        const tasks = await of.parseTasks(text, { project: options.project });
        outputJson(tasks);
      })
    );

  command
    .command('stats')
    .description('Show task statistics')
    .action(
      withErrorHandling(async () => {
        const of = new OmniFocus();
        const stats = await of.getTaskStats();
        outputJson(stats);
      })
    );

  return command;
}
