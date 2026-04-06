export async function localSkillSearch() {
  return []
}

// Restored placeholder: the original build includes a memoized skill index
// that requires explicit cache invalidation when commands are reloaded.
export function clearSkillIndexCache(): void {
  // no-op in the restored tree until localSkillSearch is fully reconstructed
}
