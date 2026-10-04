import type { ToolDefinition } from './connector-store.js';
/**
 * Keyword search over tool names and descriptions: exact name first, then by how many query
 * words match (name matches count double). Shared by the
 * REST API and the MCP server.
 */
export function searchTools(tools: ToolDefinition[], input: { query?: string; limit: number; offset: number; read_only?: boolean }) {
  const words = (input.query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const exact = (input.query || '').trim().toLowerCase();
  // Score: each query word found in the name counts 2, in the description 1.
  const score = (t: ToolDefinition) => words.reduce((sum, w) => sum + (t.name.toLowerCase().includes(w) ? 2 : t.description.toLowerCase().includes(w) ? 1 : 0), 0);
  const matches = tools.map(t => ({ t, s: score(t) })).filter(({ t, s }) => (input.read_only === undefined || t.read_only === input.read_only) && (!words.length || s > 0))
    .sort((a, b) => Number(b.t.name.toLowerCase() === exact) - Number(a.t.name.toLowerCase() === exact) || b.s - a.s || a.t.connector.localeCompare(b.t.connector) || a.t.name.localeCompare(b.t.name))
    .map(({ t }) => t);
  return { data: matches.slice(input.offset, input.offset + input.limit), total: matches.length, next_offset: input.offset + input.limit < matches.length ? input.offset + input.limit : null };
}
