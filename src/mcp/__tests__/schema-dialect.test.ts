import { describe, it, expect } from 'vitest';
import { createMcpServer } from '../server.js';
import type { OmniFocus } from '../../lib/omnifocus.js';

/**
 * Regression guard for the JSON Schema dialect advertised by every tool.
 *
 * Background: under @modelcontextprotocol/sdk v1 + zod v3, every tool's
 * outputSchema was serialised with `"$schema": "http://json-schema.org/draft-07/schema#"`.
 * Clients whose validator only registers the 2020-12 meta-schema (Claude Code /
 * Cowork among them) reject such a tool outright, so all 48 tools were disabled
 * client-side before the server was ever contacted.
 *
 * The whole suite passed throughout, because nothing asserted on *serialised*
 * schema output — every other schema test calls `.safeParse()` against the zod
 * schema objects directly, which cannot observe the dialect. These tests close
 * that hole: they read `RegisteredTool.outputSchemaJson`, which the SDK memoises
 * at registration and is the very object `tools/list` puts on the wire.
 *
 * `outputSchemaJson` is `@hidden` in the SDK's own type declarations — an
 * internal memoisation detail, not part of its documented public API — so a
 * future SDK bump could rename or drop it without a changelog entry. If a
 * test here starts failing with every `outputSchemaJson` read coming back
 * `undefined`, that's why: re-derive the assertions from `tools/list`'s wire
 * output directly instead of this field.
 *
 * Registration never invokes a tool handler, so a plain `{} as OmniFocus` is
 * a sufficient stand-in — nothing here talks to OmniFocus.
 */

const DIALECT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

/**
 * Collects the JSON-pointer-style path of every `additionalProperties: false`
 * node anywhere in a JSON Schema tree (root, `properties`, array `items`,
 * `$defs`, etc.) — a closed schema at ANY depth breaks forward compatibility
 * for that field, not just at the root.
 */
function findClosedNodes(schema: unknown, path = '$'): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const node = schema as Record<string, unknown>;
  const hits = node.additionalProperties === false ? [path] : [];
  for (const [key, value] of Object.entries(node)) {
    if (Array.isArray(value)) {
      value.forEach((v, i) => hits.push(...findClosedNodes(v, `${path}.${key}[${i}]`)));
    } else if (value && typeof value === 'object') {
      hits.push(...findClosedNodes(value, `${path}.${key}`));
    }
  }
  return hits;
}

describe('advertised JSON Schema dialect', () => {
  const { registered } = createMcpServer({} as OmniFocus);

  it('registers the full tool catalogue, including the two MCP Apps', () => {
    // 46 core tools (buildTools) + get_stats_dashboard + triage_tasks.
    expect(registered.length).toBe(48);
  });

  it('declares 2020-12 explicitly wherever a dialect is declared', () => {
    const offenders = registered
      .filter((t) => typeof t.outputSchemaJson?.$schema === 'string')
      .filter((t) => t.outputSchemaJson?.$schema !== DIALECT_2020_12)
      .map((t) => `${t.title}: ${t.outputSchemaJson?.$schema}`);

    expect(offenders).toEqual([]);
  });

  it('serialises an outputSchema for every registered tool', () => {
    const missing = registered.filter((t) => t.outputSchema && !t.outputSchemaJson);
    expect(missing).toEqual([]);
  });

  it('keeps .loose() schemas open for forward compatibility, at every nesting depth', () => {
    // A serializer gaining a field must not fail client-side validation. zod v4
    // emits `additionalProperties: {}` (an unconstrained schema) where v3 emitted
    // `true`; both mean "accept unknown keys" per JSON Schema, so accept either —
    // only an explicit `false` (a closed schema) is a failure. Walks the whole
    // outputSchemaJson tree, not just the root: a nested object (inside
    // `properties`, an array's `items`, or a `$defs` entry) can be closed
    // independently of its parent staying open.
    const closed = registered.flatMap((t) =>
      findClosedNodes(t.outputSchemaJson).map((path) => `${t.title} ${path}`)
    );

    expect(closed).toEqual([]);
  });
});
