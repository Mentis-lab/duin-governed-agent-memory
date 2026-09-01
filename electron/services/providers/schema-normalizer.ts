/**
 * FC-3 — Provider schema normalizer.
 *
 * Adapts Lamprey's canonical tool descriptors into provider-specific tool
 * arrays. Per the FC-0 audit, all four providers (DeepSeek, Google, DashScope,
 * OpenRouter) accept standard OpenAI-format tool schemas with the same
 * accepted subset:
 *
 *   ✅ type, properties, required, description, enum, items, additionalProperties
 *   ❌ $ref, oneOf, anyOf, allOf
 *
 * The normalizer's primary job is therefore validation and safety, not
 * structural transformation:
 *
 *  1. Strip unsupported JSON Schema keywords from every tool's parameters.
 *  2. Core tools with unsupported keywords that CANNOT be stripped cause a
 *     startup-time failure.
 *  3. Non-core tools with unsupported keywords are dropped with a logged
 *     warning naming the tool, provider, and unsupported keyword.
 *  4. MCP-originating tools (if exposed to models) pass through the same
 *     normalization pathway.
 */

import type { ChatCompletionTool } from 'openai/resources/chat/completions'
import type { ProviderId } from './registry'

export interface ProviderTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/**
 * Dedupe a model-facing tool array by function name, keeping the FIRST occurrence.
 * OpenAI/DeepSeek (and other strict providers) return 400 "Tool names must be unique"
 * and hard-fail the entire turn if any name repeats; GLM silently tolerates it. Tool
 * surfaces assembled by concatenation (brain natives ++ MCP, multiple registries) have
 * no inherent uniqueness guard, so this is the single choke point that keeps a collision
 * — present or future — from breaking chat on a strict provider. First-wins so a curated
 * native tool is never shadowed by a later MCP/dynamic duplicate. Entries with no name
 * are dropped. Returns the deduped list plus the dropped names (for logging).
 */
export function dedupeToolsByName(tools: ProviderTool[]): { tools: ProviderTool[]; dropped: string[] } {
  const seen = new Set<string>()
  const out: ProviderTool[] = []
  const dropped: string[] = []
  for (const t of tools) {
    const name = t?.function?.name
    if (!name) {
      dropped.push('(unnamed)')
      continue
    }
    if (seen.has(name)) {
      dropped.push(name)
      continue
    }
    seen.add(name)
    out.push(t)
  }
  return { tools: out, dropped }
}

/**
 * Keywords that are NOT supported by any of Lamprey's OpenAI-compatible
 * providers. Tools using these keywords have them stripped if possible;
 * if the keyword is structural (cannot be removed without breaking the
 * schema), the tool is either failed (core) or dropped (non-core).
 */
const UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  '$ref',
  'oneOf',
  'anyOf',
  'allOf',
  '$schema',
  '$id',
  'definitions',
  '$defs',
  'patternProperties',
  'if',
  'then',
  'else',
  'not',
  'dependencies',
  'dependentRequired',
  'dependentSchemas',
  'unevaluatedProperties',
  'unevaluatedItems',
  'contains',
  'minContains',
  'maxContains',
  'propertyNames',
  'prefixItems'
])

/**
 * Structural keywords — if present, the schema cannot be meaningfully
 * normalized and the tool must be dropped (or failed for core tools).
 */
const STRUCTURAL_UNSUPPORTED = new Set([
  '$ref',
  'oneOf',
  'anyOf',
  'allOf'
])

/**
 * Core tools. These are the essential tools Lamprey requires to function.
 * If a core tool's schema cannot be normalized, the harness fails at startup
 * with a clear error.
 */
const CORE_TOOL_NAMES = new Set([
  'workspace_context',
  'view_image',
  'shell_command',
  'apply_patch',
  'verify_workspace',
  'shell_list',
  'shell_monitor',
  'shell_stop',
  'shell_output'
])

export interface NormalizerResult {
  tools: ProviderTool[]
  warnings: string[]
}

/**
 * Check if a schema object contains unsupported structural keywords
 * at any depth. Returns the first offending keyword found, or null.
 */
function findStructuralUnsupported(schema: unknown, path: string): string | null {
  if (!schema || typeof schema !== 'object') return null
  const obj = schema as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    if (STRUCTURAL_UNSUPPORTED.has(key)) return key
    // Recurse into properties and items
    if (key === 'properties' && obj.properties && typeof obj.properties === 'object') {
      const props = obj.properties as Record<string, unknown>
      for (const [propName, propSchema] of Object.entries(props)) {
        const found = findStructuralUnsupported(propSchema, `${path}.properties.${propName}`)
        if (found) return found
      }
    }
    if (key === 'items' && obj.items && typeof obj.items === 'object') {
      const found = findStructuralUnsupported(obj.items, `${path}.items`)
      if (found) return found
    }
    // Recurse into nested objects that aren't standard schema keywords
    if (
      typeof obj[key] === 'object' &&
      obj[key] !== null &&
      !Array.isArray(obj[key]) &&
      !['properties', 'items', 'enum'].includes(key)
    ) {
      const found = findStructuralUnsupported(obj[key], `${path}.${key}`)
      if (found) return found
    }
  }
  return null
}

/**
 * Strip non-structural unsupported keywords from a schema object.
 * Returns a new object with unsupported keys removed at all depths.
 */
function stripUnsupportedKeywords(schema: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_SCHEMA_KEYWORDS.has(key) && !STRUCTURAL_UNSUPPORTED.has(key)) {
      continue // Strip non-structural unsupported keys
    }
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      key !== 'enum' // Don't recurse into enum arrays
    ) {
      cleaned[key] = stripUnsupportedKeywords(value as Record<string, unknown>)
    } else if (Array.isArray(value)) {
      // For arrays (like enum), just copy
      cleaned[key] = value
    } else {
      cleaned[key] = value
    }
  }
  return cleaned
}

/**
 * Normalize tool descriptors for a specific provider.
 *
 * @param tools       Lamprey tool descriptors from the registry.
 * @param _provider   Target provider (unused currently — all providers accept
 *                    the same subset per FC-0, but kept as a seam for future
 *                    provider-specific adjustments).
 */
export function normalizeToolsForProvider(
  tools: Array<{ name: string; description: string; inputSchema: unknown; providerKind?: string }>,
  _provider: ProviderId
): NormalizerResult {
  const result: ProviderTool[] = []
  const warnings: string[] = []

  for (const tool of tools) {
    const inputSchema = tool.inputSchema as Record<string, unknown> | undefined
    if (!inputSchema || typeof inputSchema !== 'object') {
      // RESILIENCE: a single malformed tool must NEVER abort the whole tool
      // build. Previously a core tool with a bad schema threw here, which
      // propagated up through getNormalizedToolsForRole → the chat was handed
      // ZERO tools (the model then "can't do anything"). Drop the offending
      // tool loudly and keep the rest.
      const coreTag = CORE_TOOL_NAMES.has(tool.name)
        ? ' [CORE TOOL — fix its inputSchema; the rest of the catalog is preserved]'
        : ''
      warnings.push(
        `Dropping tool "${tool.name}" — missing or invalid inputSchema (provider "${_provider}").${coreTag}`
      )
      continue
    }

    // Check for structural unsupported keywords
    const structural = findStructuralUnsupported(inputSchema, '')
    if (structural) {
      const coreTag = CORE_TOOL_NAMES.has(tool.name)
        ? ' [CORE TOOL — fix its inputSchema; the rest of the catalog is preserved]'
        : ''
      warnings.push(
        `Dropping tool "${tool.name}" — uses unsupported structural keyword "${structural}" (provider "${_provider}").${coreTag}`
      )
      continue
    }

    // Strip non-structural unsupported keywords
    const parameters = stripUnsupportedKeywords(inputSchema)

    // Ensure type: "object" is present
    if (!parameters.type) {
      parameters.type = 'object'
    }

    result.push({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters
      }
    })
  }

  return { tools: result, warnings }
}
