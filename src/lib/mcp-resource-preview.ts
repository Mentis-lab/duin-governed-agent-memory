// mcp-resource-preview.ts — renderer-side policy for how a read MCP resource is
// previewed. SAFE by construction: text renders as escaped React text; only a
// closed allow-list of raster image mime types becomes an inline data URL;
// everything else (SVG — which can carry script — and every binary blob) is
// metadata-only. External opens are limited to credential-free HTTP(S).

import type { McpResourceContent } from './types'

// Raster only. SVG is deliberately excluded: it is an active document that can
// embed <script>, so it never becomes an <img src> data URL here.
const SAFE_RASTER_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif'
])

export type McpPreviewItem =
  | { kind: 'text'; uri: string; mimeType: string; text: string }
  | { kind: 'image'; uri: string; mimeType: string; dataUrl: string }
  | { kind: 'metadata'; uri: string; mimeType: string; byteEstimate?: number }

export function classifyMcpResourceContent(content: McpResourceContent): McpPreviewItem {
  const mimeType = content.mimeType?.trim().toLowerCase() || 'application/octet-stream'
  if ('text' in content) {
    return { kind: 'text', uri: content.uri, mimeType, text: content.text }
  }
  if (SAFE_RASTER_MIME_TYPES.has(mimeType)) {
    return {
      kind: 'image',
      uri: content.uri,
      mimeType,
      dataUrl: `data:${mimeType};base64,${content.blob}`
    }
  }
  return {
    kind: 'metadata',
    uri: content.uri,
    mimeType,
    byteEstimate: Math.floor((content.blob.length * 3) / 4)
  }
}

export function canOpenMcpResourceExternally(uri: string): boolean {
  try {
    const url = new URL(uri)
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
  } catch {
    return false
  }
}
