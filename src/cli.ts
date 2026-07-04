#!/usr/bin/env node

import { Command, CommanderError } from 'commander';
import { handleError } from './lib/errors.js';
import { setOutputOptions } from './lib/output.js';
import { createTaskCommand } from './commands/task.js';
import { createProjectCommand } from './commands/project.js';
import { createInboxCommand } from './commands/inbox.js';
import { createSearchCommand } from './commands/search.js';
import { createPerspectiveCommand } from './commands/perspective.js';
import { createTagCommand } from './commands/tag.js';
import { createFolderCommand } from './commands/folder.js';
import { createRedoCommand, createSyncCommand, createUndoCommand } from './commands/database.js';
import { createMcpCommand } from './commands/mcp.js';

const program = new Command();

program
  .name('of')
  .description('A command-line interface for OmniFocus on macOS')
  .version(__VERSION__)
  .option('-c, --compact', 'Minified JSON output (single line)')
  .exitOverride()
  .hook('preAction', (thisCommand) => {
    const options = thisCommand.opts();
    setOutputOptions({
      compact: options.compact,
    });
  });

program.addCommand(createTaskCommand());
program.addCommand(createProjectCommand());
program.addCommand(createInboxCommand());
program.addCommand(createSearchCommand());
program.addCommand(createPerspectiveCommand());
program.addCommand(createTagCommand());
program.addCommand(createFolderCommand());
program.addCommand(createUndoCommand());
program.addCommand(createRedoCommand());
program.addCommand(createSyncCommand());
program.addCommand(createMcpCommand());

program.parseAsync().catch((err) => {
  if (err instanceof CommanderError) {
    // Covers --help, --version, and Commander's own parse errors (unknown
    // option, missing argument, etc.) — commander has already written the
    // relevant output, so just propagate the exit code. Set exitCode instead
    // of calling process.exit() so any queued stdout writes finish before the
    // process terminates. See errors.ts for details.
    process.exitCode = err.exitCode;
    return;
  }
  // A custom option parser (e.g. a `--status` validator) can throw a plain
  // Error/OmniFocusCliError. Commander's _callParseArg only wraps errors
  // carrying a `commander.invalidArgument` code into a CommanderError; any
  // other thrown value propagates out of parseAsync() completely unhandled,
  // before an action's withErrorHandling ever runs. Without this branch that
  // silently produced `exit 1` with no output on either stream. Route it
  // through the same handleError as every other command failure so it prints
  // the usual {"error": {...}} JSON body.
  handleError(err);
});
