import assert from 'node:assert/strict';
import { assertStrictValidation } from '../scripts/verify-publication-protection.mjs';

const required = () => ({ type: 'required_status_checks', ruleset_id: 123,
  ruleset_source_type: 'Repository', ruleset_source: 'owner/repo',
  parameters: { strict_required_status_checks_policy: true,
    required_status_checks: [{ context: 'validate', integration_id: 15368 }] } });
const client = pages => {
  const reads = [];
  return { reads, get: async endpoint => {
    reads.push(endpoint);
    assert.match(endpoint, /^\/rules\/branches\/main\?per_page=100&page=[1-9]\d*$/);
    const page = Number(new URL(`https://api.github.com${endpoint}`).searchParams.get('page'));
    if (!(page in pages)) throw new Error(`Unexpected effective-rules page ${page}`);
    return pages[page];
  } };
};
const accepts = rules => assertStrictValidation(client({ 1: rules }));
const rejects = rules => assert.rejects(accepts(rules), /strict validate|malformed effective rules/);

await accepts([required()]);
await accepts([{ type: 'pull_request' }, required(), { type: 'non_fast_forward' }]);
const inherited = required(); inherited.ruleset_source_type = 'Organization';
await accepts([inherited]);

// An existing classic protection/auto-merge flag is not evidence that strict
// validation remains effective; only the live active-rules response proves it.
await rejects([]);
await rejects(null);
await rejects({ protected: true, allow_auto_merge: true });
await rejects([{ type: 'pull_request' }]);
await rejects([{ type: 'required_status_checks' }]);
await rejects([{ ...required(), parameters: { required_status_checks: [{ context: 'validate', integration_id: 15368 }] } }]);
for (const strict of [false, null, 'true', 1]) {
  const rule = required(); rule.parameters.strict_required_status_checks_policy = strict;
  await rejects([rule]);
}
for (const integration of [null, undefined, 42, '15368']) {
  const rule = required(); rule.parameters.required_status_checks[0].integration_id = integration;
  await rejects([rule]);
}
for (const context of ['test', 'Validate', 'validate ']) {
  const rule = required(); rule.parameters.required_status_checks[0].context = context;
  await rejects([rule]);
}
const laxValidate = required(); laxValidate.parameters.strict_required_status_checks_policy = false;
const strictOther = required(); strictOther.parameters.required_status_checks[0].context = 'other';
await rejects([laxValidate, strictOther]);
for (const checks of [undefined, [], 'validate', { context: 'validate', integration_id: 15368 }, [null]]) {
  const rule = required(); rule.parameters.required_status_checks = checks;
  await rejects([rule]);
}

// Do not mistake the first page of an inherited policy set for all policies.
const unrelated = Array.from({ length: 100 }, () => ({ type: 'non_fast_forward' }));
const paginated = client({ 1: unrelated, 2: [required()] });
await assertStrictValidation(paginated);
assert.equal(paginated.reads.length, 2);
await assert.rejects(assertStrictValidation(client({ 1: unrelated, 2: [] })), /strict validate/);
await rejects(Array.from({ length: 101 }, required));

// Network/authorization failures never become an assumed successful guard.
const unavailable = new Error('HTTP 403');
await assert.rejects(assertStrictValidation({ get: async () => { throw unavailable; } }), error => error === unavailable);
console.log('Publication strict-validation guard tests passed');
