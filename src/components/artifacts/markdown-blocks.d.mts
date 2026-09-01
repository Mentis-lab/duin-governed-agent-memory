// Types for the pure ESM markdown-blocks core (shared by MarkdownRenderer + efficiency-benchmark).
export function splitMarkdownBlocks(text: string): string[]
export function createBlockStream(): { push(chunk: string): { closed: string[]; open: string } }
export function collectRefDefinitions(text: string): string
export function streamRenderWork(nBlocks: number): number
