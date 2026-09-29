// Stands in for a check with little output, such as a clean lint or typecheck run.
// Usage: node quiet-check.js <label>
const label = process.argv[2] || 'check';
process.stdout.write(`\n> acme-orders@0.4.2 ${label}\n> ${label === 'lint' ? 'eslint .' : 'tsc --noEmit'}\n\n`);
