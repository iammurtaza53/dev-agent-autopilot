#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2)).catch((error) => {
  // Errors carry actionable messages; set DEV_AUTOPILOT_DEBUG=1 to see the stack trace too.
  const detail = process.env.DEV_AUTOPILOT_DEBUG ? error?.stack : error?.message;
  console.error(`Autopilot failed: ${detail || error}`);
  process.exitCode = 1;
});
