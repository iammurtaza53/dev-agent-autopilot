// Prints a deterministic, Vitest-style verbose test log, the kind a mid-size service produces on every run.
// Usage: node verbose-tests.js <tests> [failingTestNumber]
const total = Number(process.argv[2] || 400);
const failing = process.argv[3] === undefined ? -1 : Number(process.argv[3]);
const suites = [
  ['unit/orders/pricing', 'pricing', ['applies line discounts in minor units', 'rejects mixed currencies', 'rounds tax half-even', 'sums empty orders to zero']],
  ['unit/orders/format', 'formatOrderNumber', ['pads the sequence to six digits', 'uses the AC prefix and year', 'formats money with the currency symbol', 'describes every status']],
  ['unit/orders/states', 'transition', ['moves draft to pending_payment', 'refuses paid to draft', 'emits outbox events for paid', 'cancels from pending_payment']],
  ['unit/inventory/stock', 'available stock', ['subtracts held reservations', 'subtracts committed reservations', 'ignores released reservations', 'is per warehouse']],
  ['integration/inventory/reservations', 'reservations', ['reserves every line or none', 'commits on payment', 'releases on cancel', 'finds expired holds oldest first']],
  ['integration/payments/webhooks', 'webhooks', ['verifies the signature first', 'is idempotent per event id', 'stores unknown events', 'marks orders paid']],
  ['unit/notifications/templates', 'templates', ['renders the confirmation email', 'renders the shipment SMS', 'falls back to text', 'uses formatted order numbers']],
  ['api/orders', 'orders routes', ['creates an order', 'returns 404 for unknown ids', 'paginates with cursors', 'filters by status']],
  ['integration/jobs/runner', 'jobs runner', ['takes the Redis lock', 'skips when locked', 'logs the summary line', 'records the duration histogram']],
  ['integration/db/tx', 'withTransaction', ['retries serialization failures', 'rolls back on error', 'gives up after three attempts', 'never nests']],
];
const green = (text) => `\u001b[32m${text}\u001b[39m`;
const red = (text) => `\u001b[31m${text}\u001b[39m`;
const dim = (text) => `\u001b[2m${text}\u001b[22m`;
const out = [];
let failedName = null;
out.push('', ` ${dim('RUN')}  v2.1.9 /work/acme-orders`, '');
for (let index = 1; index <= total; index += 1) {
  const [file, describe, cases] = suites[index % suites.length];
  const name = `${cases[index % cases.length]} (case ${index})`;
  const ms = (index * 7) % 23;
  if (index === failing) {
    failedName = `test/${file}.test.ts > ${describe} > ${name}`;
    out.push(` ${red('×')} ${failedName} ${ms}ms`);
  } else {
    out.push(` ${green('✓')} test/${file}.test.ts > ${describe} > ${name} ${dim(`${ms}ms`)}`);
  }
}
out.push('');
if (failedName) {
  out.push(red('⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯'), '');
  out.push(` ${red('FAIL')}  ${failedName}`);
  out.push(`${red('AssertionError')}: expected 'held' to be 'released' // Object.is equality`);
  out.push('', `${green('- Expected')}`, `${red('+ Received')}`, '', `${green('- released')}`, `${red('+ held')}`, '');
  out.push(' ❯ test/integration/inventory/reservations.test.ts:88:41');
  out.push('     86|     await job.run(deps);');
  out.push('     87|     const [reservation] = await findReservations(order.id);');
  out.push("     88|     expect(reservation.status).toBe('released');");
  out.push('       |                                         ^');
  out.push('     89|   });', '');
  out.push(red('⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯'), '');
}
const passed = total - (failedName ? 1 : 0);
out.push(` Test Files  ${failedName ? `${red('1 failed')} | ${green(`${suites.length - 1} passed`)}` : green(`${suites.length} passed`)} (${suites.length})`);
out.push(`      Tests  ${failedName ? `${red('1 failed')} | ${green(`${passed} passed`)}` : green(`${passed} passed`)} (${total})`);
out.push('   Start at  10:00:00');
out.push(`   Duration  ${(total * 0.031).toFixed(2)}s (transform 1.20s, setup 0.40s, collect 3.10s, tests ${(total * 0.02).toFixed(2)}s)`);
out.push('');
process.stdout.write(`${out.join('\n')}\n`);
process.exitCode = failedName ? 1 : 0;
