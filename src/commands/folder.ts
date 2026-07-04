import { Command } from 'commander';
import { outputJson } from '../lib/output.js';
import { withErrorHandling } from '../lib/command-utils.js';
import { OmniFocus } from '../lib/omnifocus.js';
import type { FolderFilters, UpdateFolderOptions } from '../types.js';

export function createFolderCommand(): Command {
  const command = new Command('folder');
  command.description('Manage OmniFocus folders');

  command
    .command('list')
    .alias('ls')
    .description('List top-level folders with nested children')
    .option('-d, --dropped', 'Include dropped folders')
    .action(
      withErrorHandling(async (options) => {
        const of = new OmniFocus();
        const folders = await of.listFolders({ includeDropped: options.dropped });
        outputJson(folders);
      })
    );

  command
    .command('view <idOrName>')
    .description('View folder details and children')
    .option('-d, --dropped', 'Include dropped child folders')
    .action(
      withErrorHandling(async (idOrName, options) => {
        const of = new OmniFocus();
        const filters: FolderFilters = { includeDropped: options.dropped };
        const folder = await of.getFolder(idOrName, filters);
        outputJson(folder);
      })
    );

  command
    .command('create <name>')
    .description('Create a new folder')
    .option('-p, --parent <name>', 'Create inside this parent folder')
    .action(
      withErrorHandling(async (name, options) => {
        const of = new OmniFocus();
        const folder = await of.createFolder({ name, parent: options.parent });
        outputJson(folder);
      })
    );

  command
    .command('update <idOrName>')
    .description('Update an existing folder')
    .option('-n, --name <name>', 'Rename folder')
    .option('-s, --status <status>', 'Set status (active, dropped)')
    .option('-p, --parent <name>', 'Move into this parent folder')
    .action(
      withErrorHandling(async (idOrName, options) => {
        const of = new OmniFocus();
        const updates: UpdateFolderOptions = {
          ...(options.name && { name: options.name }),
          ...(options.status && { status: options.status }),
          ...(options.parent && { parent: options.parent }),
        };
        const folder = await of.updateFolder(idOrName, updates);
        outputJson(folder);
      })
    );

  command
    .command('delete <idOrName>')
    .alias('rm')
    .description('Delete a folder')
    .action(
      withErrorHandling(async (idOrName) => {
        const of = new OmniFocus();
        await of.deleteFolder(idOrName);
        outputJson({ message: 'Folder deleted successfully' });
      })
    );

  command
    .command('search <query>')
    .description('Fuzzy-search folders (Quick Open matching)')
    .action(
      withErrorHandling(async (query) => {
        const of = new OmniFocus();
        const folders = await of.searchFolders(query);
        outputJson(folders);
      })
    );

  return command;
}
