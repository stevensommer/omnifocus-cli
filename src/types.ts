/**
 * OmniFocus's own Task.Status values (lowercased). "actionable" is a
 * filter-only pseudo-status matching available | next | dueSoon | overdue —
 * i.e. everything that can be worked on right now.
 */
export type TaskStatus =
  | 'available'
  | 'next'
  | 'blocked'
  | 'dueSoon'
  | 'overdue'
  | 'completed'
  | 'dropped';

export type TaskStatusFilter = TaskStatus | 'actionable';

export interface Task {
  id: string;
  name: string;
  note: string | null;
  completed: boolean;
  dropped: boolean;
  effectivelyActive: boolean;
  flagged: boolean;
  effectiveFlagged: boolean;
  taskStatus: TaskStatus;
  project: string | null;
  tags: string[];
  defer: string | null;
  due: string | null;
  planned: string | null;
  effectiveDefer: string | null;
  effectiveDue: string | null;
  estimatedMinutes: number | null;
  completionDate: string | null;
  dropDate: string | null;
  added: string | null;
  modified: string | null;
  url: string;
}

export interface Project {
  id: string;
  name: string;
  note: string | null;
  status: 'active' | 'on hold' | 'dropped' | 'done';
  folder: string | null;
  sequential: boolean;
  flagged: boolean;
  defer: string | null;
  due: string | null;
  completionDate: string | null;
  dropDate: string | null;
  estimatedMinutes: number | null;
  completedByChildren: boolean;
  containsSingletonActions: boolean;
  nextTask: { id: string; name: string } | null;
  taskCount: number;
  remainingCount: number;
  tags: string[];
  url: string;
}

export interface TaskFilters {
  includeCompleted?: boolean;
  includeDropped?: boolean;
  flagged?: boolean;
  project?: string;
  tag?: string;
  /** Match OmniFocus task status; "actionable" = available|next|dueSoon|overdue. */
  status?: TaskStatusFilter;
  // Date windows (ISO 8601). Due/defer compare against the task's
  // *effective* dates so container-inherited dates count; completed/added
  // compare the task's own timestamps. Setting a completed* window implies
  // includeCompleted.
  dueBefore?: string;
  dueAfter?: string;
  deferBefore?: string;
  deferAfter?: string;
  plannedBefore?: string;
  plannedAfter?: string;
  completedBefore?: string;
  completedAfter?: string;
  addedBefore?: string;
  addedAfter?: string;
}

export interface ProjectFilters {
  includeDropped?: boolean;
  status?: 'active' | 'on hold' | 'dropped';
  folder?: string;
}

export interface CreateTaskOptions {
  name: string;
  note?: string;
  project?: string;
  tags?: string[];
  defer?: string;
  due?: string;
  planned?: string;
  flagged?: boolean;
  estimatedMinutes?: number;
}

export interface UpdateTaskOptions {
  name?: string;
  note?: string;
  project?: string;
  tags?: string[];
  defer?: string | null;
  due?: string | null;
  planned?: string | null;
  flagged?: boolean;
  estimatedMinutes?: number;
  completed?: boolean;
}

export interface CreateProjectOptions {
  name: string;
  note?: string;
  folder?: string;
  sequential?: boolean;
  tags?: string[];
  status?: 'active' | 'on hold' | 'dropped';
}

export interface UpdateProjectOptions {
  name?: string;
  note?: string;
  folder?: string;
  sequential?: boolean;
  tags?: string[];
  status?: 'active' | 'on hold' | 'dropped';
}

export interface Perspective {
  id: string;
  name: string;
}

export interface Tag {
  id: string;
  name: string;
  taskCount: number;
  remainingTaskCount: number;
  added: string | null;
  modified: string | null;
  lastActivity: string | null;
  active: boolean;
  status: 'active' | 'on hold' | 'dropped';
  parent: string | null;
  children: string[];
  allowsNextAction: boolean;
  url: string;
}

export interface Folder {
  id: string;
  name: string;
  status: 'active' | 'dropped';
  effectivelyActive: boolean;
  parent: string | null;
  projectCount: number;
  remainingProjectCount: number;
  folderCount: number;
  children: Folder[];
  url: string;
}

export interface FolderFilters {
  includeDropped?: boolean;
}

export interface TagListOptions {
  unusedDays?: number;
  sortBy?: 'name' | 'usage' | 'activity';
  activeOnly?: boolean;
}

export interface TagStats {
  totalTags: number;
  activeTags: number;
  tagsWithTasks: number;
  unusedTags: number;
  avgTasksPerTag: number;
  mostUsedTags: Array<{ name: string; taskCount: number }>;
  leastUsedTags: Array<{ name: string; taskCount: number }>;
  staleTags: Array<{ name: string; daysSinceActivity: number }>;
}

export interface TaskStats {
  totalTasks: number;
  activeTasks: number;
  completedTasks: number;
  flaggedTasks: number;
  overdueActiveTasks: number;
  avgEstimatedMinutes: number | null;
  tasksWithEstimates: number;
  completionRate: number;
  tasksByProject: Array<{ name: string; taskCount: number }>;
  tasksByTag: Array<{ name: string; taskCount: number }>;
}

export interface ProjectStats {
  totalProjects: number;
  activeProjects: number;
  onHoldProjects: number;
  droppedProjects: number;
  doneProjects: number;
  sequentialProjects: number;
  parallelProjects: number;
  avgTasksPerProject: number;
  avgRemainingPerProject: number;
  avgCompletionRate: number;
  projectsWithMostTasks: Array<{ name: string; taskCount: number }>;
  projectsWithMostRemaining: Array<{ name: string; remainingCount: number }>;
}

export interface CreateTagOptions {
  name: string;
  parent?: string;
  status?: 'active' | 'on hold' | 'dropped';
}

export interface UpdateTagOptions {
  name?: string;
  status?: 'active' | 'on hold' | 'dropped';
}
