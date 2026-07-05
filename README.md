# OmniFocus CLI

[![npm version](https://img.shields.io/npm/v/@stephendolan/omnifocus-cli.svg)](https://www.npmjs.com/package/@stephendolan/omnifocus-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A command-line interface for OmniFocus on macOS.

## Installation

```bash
bun install -g @stephendolan/omnifocus-cli
```

Requires [Bun](https://bun.sh) and macOS with OmniFocus installed.

## Quick Start

```bash
of inbox count                              # Check inbox
of task list --flagged                      # Flagged tasks
of task create "Buy groceries"              # Quick capture
of task update "Buy groceries" --complete   # Mark done
```

## Commands

### Tasks

```bash
of task list                        # List active tasks
of task list --flagged              # Flagged tasks only
of task list --project "Work"       # Filter by project
of task list --tag "urgent"         # Filter by tag
of task list --completed            # Include completed

of task create "Name" [options]
  --project <name>                  # Assign to project
  --parent <name|id>                # Create as a subtask of this task
  --tag <tags...>                   # Add tags
  --due <YYYY-MM-DD>                # Set due date
  --defer <YYYY-MM-DD>              # Set defer date
  --planned <YYYY-MM-DD>            # Set planned date
  --flagged                         # Flag the task
  --estimate <minutes>              # Time estimate
  --note <text>                     # Add note

of task update <name|id> [options]
  --complete                        # Mark completed
  --flag / --unflag                 # Toggle flag
  --name <new-name>                 # Rename
  --parent <name|id>                # Reparent under another task
  --sequential / --no-sequential    # Children completed in order (or not)
  --completed-by-children           # Auto-complete when last child completes
  --project/--tag/--due/--defer     # Same as create

of task view <name|id>              # View details
of task view <name|id> --children   # Include one level of subtasks

of task repeat <name|id> --rule "FREQ=WEEKLY;BYDAY=MO"   # Repeat weekly on Mondays
  --schedule <regularly|fromCompletion>                  # Default regularly
  --anchor <dueDate|deferDate|plannedDate>               # Default dueDate
  --catch-up                                             # Skip missed occurrences
of task repeat <name|id> --clear                         # Remove the repeat

of task move <name|id> --project "Work"        # Move into a project
of task move <name|id> --parent <name|id>      # Make it a subtask
of task move <name|id> --inbox                 # Back to the inbox
of task move <name|id> --before <sibling>      # Reorder relative to a sibling
of task move <name|id> --project "Work" --position beginning

of task duplicate <name|id>                    # Copy (lands after the original)
of task duplicate <name|id> --project "Work"   # Copy into a project

of task parse "Fix gutters! ::House #friday $2h @errands //note"
  # Transport text: ! flag, ::project, #defer #due (one # = due),
  # $duration, @tag, //note, -- starts another task
of task parse "A -- B -- C" --project "Work"   # Bulk create into a project

of task delete <name|id>            # Delete task
```

### Projects

```bash
of project list                     # List active projects
of project list --folder "Work"     # Filter by folder
of project list --status "on hold"  # Filter by status
of project list --dropped           # Include dropped

of project create "Name" [options]
  --folder <name>                   # Assign to folder
  --tag <tags...>                   # Add tags
  --sequential                      # Sequential project
  --note <text>                     # Add note

of project view <name|id>           # View details
of project delete <name|id>         # Delete project
```

### Tags

```bash
of tag list                         # All tags with counts
of tag list --unused-days 30        # Stale tags
of tag list --sort usage            # Most used first
of tag list --sort activity         # Most recent first
of tag list --active-only           # Only count incomplete tasks

of tag stats                        # Usage statistics

of tag create "Name"                # Create tag
of tag create "Child" --parent "Parent"  # Nested tag

of tag view <name|path|id>          # View details
of tag update <name> --name "New"   # Rename
of tag update <name> --inactive     # Deactivate
of tag delete <name>                # Delete tag
```

### Inbox

```bash
of inbox list                       # List inbox items
of inbox count                      # Inbox count
of inbox add "Task name"            # Add task to inbox
```

### Perspectives

```bash
of perspective list                 # List all perspectives
of perspective view "Forecast"      # View tasks in perspective
```

### Folders

```bash
of folder list                      # List all folders
of folder list --dropped            # Include dropped
of folder view "Work"               # View folder details
```

### Statistics

```bash
of task stats                       # Task statistics
of project stats                    # Project statistics
of tag stats                        # Tag statistics
```

### Other

```bash
of search "query"                   # Search tasks
```

### MCP Server

`of mcp` runs the CLI as a [Model Context Protocol](https://modelcontextprotocol.io) server over stdio, exposing every OmniFocus operation as an MCP tool so agents (Claude Desktop, etc.) can manage your tasks directly.

```bash
of mcp
```

#### Connecting from Claude Desktop

Add the server to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "omnifocus": {
      "command": "of",
      "args": ["mcp"]
    }
  }
}
```

If `of` isn't on the GUI app's `PATH`, use an absolute path (`which of`) or run via npx instead:

```json
{
  "mcpServers": {
    "omnifocus": {
      "command": "npx",
      "args": ["-y", "@stephendolan/omnifocus-cli", "mcp"]
    }
  }
}
```

The first connection triggers the same macOS Automation permission prompt as the CLI.

#### Available tools

| Domain | Tools |
| --- | --- |
| Tasks | `list_tasks`, `get_task`, `create_task`, `update_task`, `update_tasks`, `drop_task`, `delete_task`, `search_tasks`, `convert_task_to_project`, `set_task_repeat`, `move_task`, `duplicate_task`, `parse_tasks`, `get_task_stats` |
| Inbox | `list_inbox`, `get_inbox_count`, `cleanup_inbox` |
| Projects | `list_projects`, `get_project`, `create_project`, `update_project`, `complete_project`, `delete_project`, `search_projects`, `list_projects_due_for_review`, `mark_project_reviewed`, `get_project_stats` |
| Tags | `list_tags`, `get_tag`, `create_tag`, `update_tag`, `delete_tag`, `search_tags`, `get_tag_stats` |
| Folders | `list_folders`, `get_folder`, `create_folder`, `update_folder`, `delete_folder`, `search_folders` |
| Perspectives | `list_perspectives`, `get_perspective_tasks` |
| Database | `undo`, `redo`, `sync_now` |
| Discovery | `search_tools` |

Every tool returns the same JSON shape as its CLI counterpart. `search_tools` takes a case-insensitive regex and returns matching tool names/descriptions — useful for agents that want to discover capabilities without loading every schema up front.

Each tool also declares a human-readable title and [MCP tool annotations](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#tool-annotations) (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), so clients like Claude Desktop can display friendly names and group tools into read-only vs write/delete categories instead of listing them all under "Other tools".

#### Structured output

Every tool declares an [`outputSchema`](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#structured-content) and returns `structuredContent` alongside the usual text block:

- Object results (a task, a project, `{count}`, stats, …) appear in `structuredContent` as-is.
- Array results are wrapped as `{ "items": [...], "count": n }`, because the spec requires an object root for `structuredContent`. The text content block keeps the raw pretty-printed array, so existing consumers of the text form see no change.
- Failed calls (`isError`) carry only the JSON error text and never `structuredContent`.

The schemas mirror the CLI's JSON output field for field and allow additional properties, so new fields can be added without breaking strict clients. Note: Claude Code versions affected by [anthropics/claude-code#25081](https://github.com/anthropics/claude-code/issues/25081) dropped tools that declare `outputSchema` from `tools/list`; update Claude Code if tools appear missing.

## JSON Output

All commands output JSON. Use `--compact` for single-line output.

```bash
of task list | jq 'length'                    # Count tasks
of task list | jq '.[] | .name'               # Task names
of task list --flagged | jq '.[] | {name, due}'  # Specific fields
```

## Task Schema

```json
{
  "id": "kXu3B-LZfFH",
  "name": "Task name",
  "completed": false,
  "flagged": true,
  "project": "Project Name",
  "tags": ["tag1", "tag2"],
  "due": "2024-01-15T00:00:00.000Z",
  "defer": null,
  "planned": null,
  "estimatedMinutes": 30,
  "note": "Notes here",
  "added": "2024-01-01T10:00:00.000Z",
  "modified": "2024-01-10T15:30:00.000Z",
  "completionDate": null
}
```

## Troubleshooting

**Permission denied**: Grant automation permission in System Settings > Privacy & Security > Automation.

**Task not found**: Use exact name or ID. IDs appear in JSON output.

**Date format**: Use ISO format `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SS`.

## Development

```bash
git clone https://github.com/stephendolan/omnifocus-cli.git
cd omnifocus-cli
bun install
bun run dev     # Watch mode
bun link        # Link globally as `of`
```

## License

MIT
