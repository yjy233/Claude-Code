/**
 * Type declarations for non-code file imports.
 */

// Markdown files imported as strings (used by bundled skills)
declare module '*.md' {
  const content: string
  export default content
}

// SKILL.md files
declare module '*/SKILL.md' {
  const content: string
  export default content
}
