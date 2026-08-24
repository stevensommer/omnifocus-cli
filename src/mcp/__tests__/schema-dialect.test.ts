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
 * Uses a Proxy mock rather than the OF_METHODS list in server.test.ts because
 * registration never invokes a handler — nothing here talks to OmniFocus.
 */

const DIALECT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

/** Any dialect that is not 2020-12 — these are what break strict clients. */
const STALE_DIALECT = /draft-0[467]|draft\/2019-09/;

function mockOf(): OmniFocus {
  return new Proxy({} as OmniFocus, {
    get: () => async () => undefined,
  });
}

describe('advertised JSON Schema dialect', () => {
  const { registered } = createMcpServer(mockOf());

  it('registers the full tool catalogue, including the two MCP Apps', () => {
    // 46 core tools (buildTools) + get_stats_dashboard + triage_tasks.
    expect(registered.length).toBe(48);
  });

  it('never advertises a pre-2020-12 dialect on any tool', () => {
    const offenders = registered
      .filter((t) => typeof t.outputSchemaJson?.$schema === 'string')
      .filter((t) => STALE_DIALECT.test(t.outputSchemaJson?.$schema as string))
      .map((t) => `${t.title}: ${t.outputSchemaJson?.$schema}`);

    expect(offenders).toEqual([]);
  });

  it('declares 2020-12 explicitly wherever a dialect is declared', () => {
    for (const t of registered) {
      const declared = t.outputSchemaJson?.$schema;
      if (declared !== undefined) {
        expect(declared).toBe(DIALECT_2020_12);
      }
    }
  });

  it('serialises an outputSchema for every registered tool', () => {
    const missing = registered.filter((t) => t.outputSchema && !t.outputSchemaJson);
    expect(missing).toEqual([]);
  });

  it('keeps .loose() schemas open for forward compatibility', () => {
    // A serializer gaining a field must not fail client-side validation. zod v4
    // emits `additionalProperties: {}` (an unconstrained schema) where v3 emitted
    // `true`; both mean "accept unknown keys" per JSON Schema, so accept either.
    const closed = registered
      .filter((t) => t.outputSchemaJson?.additionalProperties === false)
      .map((t) => t.title);

    expect(closed).toEqual([]);
  });
});
