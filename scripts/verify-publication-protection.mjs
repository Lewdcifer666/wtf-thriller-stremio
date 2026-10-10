// The publisher deliberately has no Administration permission. GitHub's
// effective-rules endpoint is readable with Metadata read and returns only
// active rules applicable to main, including inherited rulesets. The rollout
// adds a strict-validation rule without changing classic branch protection.
// This is a runtime drift guard, not a replacement for the admin-capable
// classic protection / bypass inspection required before settings changes.
export async function assertStrictValidation(api) {
  for (let page = 1; ; page++) {
    const rules = await api.get(`/rules/branches/main?per_page=100&page=${page}`);
    if (!Array.isArray(rules) || rules.length > 100) throw new Error('Cannot verify publication protection: malformed effective rules');
    const strictValidate = rules.some(rule => rule?.type === 'required_status_checks'
      && rule.parameters?.strict_required_status_checks_policy === true
      && Array.isArray(rule.parameters?.required_status_checks)
      && rule.parameters.required_status_checks.some(check => check?.context === 'validate' && check.integration_id === 15368));
    if (strictValidate) return;
    if (rules.length < 100) break;
  }
  throw new Error('Publication requires an active strict validate rule from GitHub Actions (integration 15368)');
}
