import test from 'node:test';
import assert from 'node:assert/strict';
import { formatBenchmark, runBenchmark } from '../bench/leanloop-benchmark.js';

// The LeanLoop benchmark runs the real v0.4.1 code on deterministic fixtures and compares it with v0.4.0's exact
// launch prompt and rule. Bytes are orchestration-layer bytes, not provider-billed tokens.
test('LeanLoop reduces the benchmark volume by at least half without dropping required information', async (t) => {
  const result = await runBenchmark();
  t.diagnostic(formatBenchmark(result).split('\n').slice(0, 12).join('\n'));
  const failed = result.checks.filter((check) => !check.ok).map((check) => check.label);
  assert.deepEqual(failed, [], 'every required-information check holds');
  assert.ok(result.checks.length >= 20);
  assert.ok(result.totals.reduction >= 0.5, `measured reduction ${(result.totals.reduction * 100).toFixed(1)}%`);

  const byId = Object.fromEntries(result.rows.map((row) => [row.id, row]));
  assert.deepEqual(Object.keys(byId), ['A', 'B', 'C', 'D', 'E']);
  for (const id of ['A', 'B', 'C']) {
    assert.ok(byId[id].totalV041 < byId[id].totalV040, `${id} is smaller`);
    assert.ok(byId[id].v041.context < byId[id].v040.context, `${id}: the capsule is smaller than the files v0.4.0 asked for`);
    assert.ok(byId[id].v041.checks < byId[id].v040.checks / 10, `${id}: quiet checks`);
  }
  assert.deepEqual([byId.A.codexCalls, byId.B.codexCalls, byId.C.codexCalls], [{ v040: 2, v041: 1 }, { v040: 3, v041: 2 }, { v040: 3, v041: 3 }]);
  // Resuming costs a short message in v0.4.1 where v0.4.0 sent nothing; reported, not hidden.
  assert.ok(byId.D.totalV041 > 0 && byId.D.totalV041 < 1024);
  assert.ok(byId.E.totalV041 > byId.D.totalV041);
});
