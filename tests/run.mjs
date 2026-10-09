// Runs the tests offline: no jev-buildathon kit, no network, no Jev key.
//
//   node tests/run.mjs
//
// The policies import "failproofai" and ../../../../policykit/index.mjs, which only
// exist inside the kit. This script copies the repo into a temporary folder, drops the
// stand-ins from tests/stub/ into the places the kit would provide them, and runs:
//
//   1. tests/scenarios.test.mjs   the 59 scenario cases
//   2. tests/edge-cases.test.mjs  boundaries, fail-open / fail-closed behaviour, known gaps
//
// Jev is replaced by a stub that always answers "no". So the offline run checks the
// deterministic rules only. To test the Jev verdicts for real, run scenarios.test.mjs
// inside the kit with Jev configured (see README).
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = mkdtempSync(join(tmpdir(), "ledger-offline-"));

let failed = false;
try {
  cpSync(join(repo, "agents"), join(sandbox, "agents"), { recursive: true });
  cpSync(join(repo, "tests"), join(sandbox, "tests"), { recursive: true });
  mkdirSync(join(sandbox, "node_modules"), { recursive: true });
  cpSync(join(repo, "tests", "stub", "failproofai"), join(sandbox, "node_modules", "failproofai"), { recursive: true });
  cpSync(join(repo, "tests", "stub", "policykit"), join(sandbox, "policykit"), { recursive: true });

  const runs = [
    ["scenarios (59 cases)", ["tests/scenarios.test.mjs"]],
    ["edge cases", ["--test", "tests/edge-cases.test.mjs"]],
  ];
  for (const [label, args] of runs) {
    console.log(`\n=== ${label} ===`);
    const r = spawnSync(process.execPath, args, { cwd: sandbox, stdio: "inherit" });
    if (r.status !== 0) failed = true;
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(failed ? "\nFAILED" : "\nAll offline tests passed.");
process.exit(failed ? 1 : 0);
