import { Command } from 'commander';
import { outputJson } from '../lib/output.js';
import { withErrorHandling } from '../lib/command-utils.js';
import { OmniFocus } from '../lib/omnifocus.js';

/**
 * Top-level database verbs: undo/redo (agent safety valve after a bad batch
 * operation) and sync (save, which triggers a sync when sync is enabled).
 * Undo granularity is OmniFocus's action grouping — one script execution is
 * typically one undo group.
 */

export function createUndoCommand(): Command {
  return new Command('undo').description('Undo the last change in OmniFocus').action(
    withErrorHandling(async () => {
      const of = new OmniFocus();
      outputJson(await of.undo());
    })
  );
}

export function createRedoCommand(): Command {
  return new Command('redo').description('Redo the last undone change in OmniFocus').action(
    withErrorHandling(async () => {
      const of = new OmniFocus();
      outputJson(await of.redo());
    })
  );
}

export function createSyncCommand(): Command {
  return new Command('sync')
    .description('Save the OmniFocus database (triggers a sync when sync is enabled)')
    .action(
      withErrorHandling(async () => {
        const of = new OmniFocus();
        outputJson(await of.syncNow());
      })
    );
}
