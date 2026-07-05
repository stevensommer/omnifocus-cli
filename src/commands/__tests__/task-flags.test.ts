import { describe, expect, it } from 'vitest';
import { moveOptionsFromFlags } from '../task.js';

/**
 * Unit tests for moveOptionsFromFlags: the CLI flag -> MoveTaskOptions mapper
 * for `of task move` / `of task duplicate`. --position, --before and --after
 * all resolve to the single `position` field, so conflicting combinations must
 * be rejected up front rather than silently resolved by spread order.
 */
describe('moveOptionsFromFlags', () => {
  it('maps a single container destination', () => {
    expect(moveOptionsFromFlags({ project: 'House' })).toEqual({ project: 'House' });
    expect(moveOptionsFromFlags({ parent: 'p1' })).toEqual({ parentTask: 'p1' });
    expect(moveOptionsFromFlags({ inbox: true })).toEqual({ inbox: true });
  });

  it('maps a single positional flag', () => {
    expect(moveOptionsFromFlags({ position: 'beginning' })).toEqual({ position: 'beginning' });
    expect(moveOptionsFromFlags({ before: 'sib' })).toEqual({ position: { before: 'sib' } });
    expect(moveOptionsFromFlags({ after: 'sib' })).toEqual({ position: { after: 'sib' } });
  });

  it('allows a container destination combined with a position edge', () => {
    expect(moveOptionsFromFlags({ project: 'House', position: 'beginning' })).toEqual({
      project: 'House',
      position: 'beginning',
    });
  });

  it('rejects invalid position values', () => {
    expect(() => moveOptionsFromFlags({ position: 'middle' })).toThrow(/Invalid position/);
  });

  it('rejects --before combined with --after', () => {
    expect(() => moveOptionsFromFlags({ before: 'b', after: 'c' })).toThrow(
      /Conflicting position flags: --before, --after/
    );
  });

  it('rejects --position combined with --before', () => {
    expect(() => moveOptionsFromFlags({ position: 'beginning', before: 'b' })).toThrow(
      /Conflicting position flags: --position, --before/
    );
  });

  it('rejects all three positional flags at once', () => {
    expect(() => moveOptionsFromFlags({ position: 'end', before: 'b', after: 'c' })).toThrow(
      /Conflicting position flags/
    );
  });
});
