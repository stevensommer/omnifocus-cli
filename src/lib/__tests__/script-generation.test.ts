import { describe, expect, it } from 'vitest';
import { OmniFocus } from '../omnifocus.js';

/**
 * Regression tests for the generated Omni Automation scripts. These intercept
 * the private executeJXA seam so the exact script text can be asserted without
 * OmniFocus or osascript (no `vi` — the suite must pass under both `vitest`
 * and bun's native runner).
 */

function captureScript(returnValue: string): { of: OmniFocus; scripts: string[] } {
  const of = new OmniFocus();
  const scripts: string[] = [];
  (of as unknown as { executeJXA: (script: string) => Promise<string> }).executeJXA = async (
    script: string
  ) => {
    scripts.push(script);
    return returnValue;
  };
  return { of, scripts };
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
