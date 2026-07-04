import { Command } from 'commander';
import { outputJson } from '../lib/output.js';
import { withErrorHandling } from '../lib/command-utils.js';
import { OmniFocus } from '../lib/omnifocus.js';
import { parseDateTime } from '../lib/dates.js';
import type { TaskFilters, TaskStatusFilter, UpdateTaskOptions } from '../types.js';

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

function parseStatusFilter(value: string): TaskStatusFilter {
  if (!(TASK_STATUS_FILTERS as string[]).includes(value)) {
    throw new Error(`Invalid status "${value}". Valid: ${TASK_STATUS_FILTERS.join(', ')}`);
  }
  return value as TaskStatusFilter;
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
        const of = new OmniFocus();
        const updates: UpdateTaskOptions = {
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
        };
        const task = await of.updateTask(idOrName, updates);
        outputJson(task);
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
    .action(
      withErrorHandling(async (idOrName) => {
        const of = new OmniFocus();
        const task = await of.getTask(idOrName);
        outputJson(task);
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
