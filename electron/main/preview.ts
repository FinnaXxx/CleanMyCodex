/**
 * Shared cleaning for Codex session previews and thread titles.
 *
 * Codex wraps the real question behind a marker: the desktop app writes a
 * `## My request:` heading (after a `# Files mentioned by the user:` block),
 * and the CLI writes an inline `my request for codex:`. Both the rollout files
 * and the `state*.sqlite` thread table store the raw wrapper text in their
 * title/preview/first-user-message fields, so the same stripping has to run on
 * every one of them. The heading form requires a `#` prefix, so a user typing
 * "my request" is never mistaken for scaffolding; the inline CLI marker is
 * matched anywhere.
 */
const PREAMBLE_MARKERS = ['<environment_context', '<user_instructions', '<user_shell', '<agents', '# agents.md', 'you are a coding agent', '# files mentioned by the user']

function stripRequestPreamble(value: string): string {
  const heading = value.match(/^#+\s*my request\b[^\n]*\n/im)
  if (heading && heading.index !== undefined) return value.slice(heading.index + heading[0].length).trim()
  const marker = value.toLowerCase().indexOf('my request for codex:')
  if (marker >= 0) return value.slice(marker + 'my request for codex:'.length).trim()
  return value
}

export function cleanPreview(text: unknown): string | null {
  if (typeof text !== 'string' || !text) return null
  let value = text.trim()
  value = stripRequestPreamble(value)
  if (!value || value.startsWith('<')) return null
  const head = value.slice(0, 400).toLowerCase()
  if (PREAMBLE_MARKERS.some((item) => head.includes(item))) return null
  value = value.replace(/\s+/g, ' ')
  return value.length > 90 ? `${value.slice(0, 90)}…` : value
}