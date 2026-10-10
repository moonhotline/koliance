import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Coverage floor for the perp module.
 *
 * Hardhat 3 ships coverage natively (`hardhat test --coverage`) but its config
 * accepts only `skipFiles` — there is no threshold option, so the report is
 * purely informational and a regression would pass CI silently. Both third-party
 * alternatives (solidity-coverage, hardhat-coverage) declare a `hardhat: ^2.11.0`
 * peer and do not work here.
 *
 * So the gate is this script: parse the lcov the run already produces, and fail
 * if the module drops below the floor. Run it straight after `--coverage`.
 *
 *   npx hardhat test --coverage && npx tsx scripts/check-coverage.ts
 *
 * The thresholds are set just under the measured values, deliberately. A floor
 * set at the current number fails on the next unrelated refactor and gets
 * deleted by whoever is in a hurry; a floor a few points down still catches a
 * real regression without becoming noise. Raise them as the numbers climb.
 */

/**
 * What counts toward the score.
 *
 * Mocks are excluded on purpose. `MockERC20`, `MockPyth` and
 * `MockPositionManager` are test doubles: their untested branches are branches
 * that no test needed to exercise, and including them drags the number down
 * without saying anything about production code. `MockUSDC` is NOT a double in
 * the same sense — the demo uses it as the real collateral token — so it stays.
 *
 * `contracts/` also holds the identity module (Koliance.sol), which is outside
 * the perp workstream and has its own pre-existing coverage.
 */
const INCLUDED_PREFIXES = [
  "contracts/perp/PositionManager.sol",
  "contracts/perp/Vault.sol",
  "contracts/perp/PythOracleAdapter.sol",
  "contracts/perp/DemoOracle.sol",
  // ADR-004's on-chain delegation anchor. Gated for the same reason as the
  // rest: a contract in this module that nothing measures is a contract whose
  // regression nobody notices. It is the newest file here and the one whose
  // failure mode (a forged or replayed delegation) is least likely to show up
  // in a demo and most likely to matter.
  "contracts/perp/SessionKeyRegistry.sol",
  "contracts/perp/MockUSDC.sol",
  "contracts/perp/utils/Ownable.sol",
  "contracts/perp/utils/SafeCast.sol",
] as const;

/**
 * Floors, as percentages.
 *
 * LINE ONLY. Hardhat 3's lcov writer emits `DA:`/`LF:`/`LH:` but NO branch
 * records at all — verified by grepping the generated file: BRF, BRH and BRDA
 * all appear zero times. So there is no branch data to gate on, and an earlier
 * version of this script reported "branches 100.00%" on every file purely
 * because it divided by zero and defaulted to 100. That is a false green, which
 * is worse than no gate: it would have stayed green while branch coverage rotted.
 *
 * If Hardhat starts emitting BRDA, `MIN_BRANCH_PCT` below can be switched on. The
 * `branchesFound === 0` path now reports `n/a` and refuses to score, rather than
 * inventing a number.
 *
 * ⚠️ THE NUMBER IS LINE-ENDING SENSITIVE. Read this before changing the floor.
 *
 * Hardhat maps executed bytecode back to source by BYTE OFFSET, so a CRLF
 * checkout and an LF checkout do not measure the same thing from identical code.
 * Measured on this repo, same solc, same tests:
 *
 *   CRLF working tree (Windows default)   94.37%
 *   LF working tree   (Linux, and CI)     89.22%
 *
 * The floor was first set to 93% from a local 94.37%, and CI failed on its first
 * real run at 89.22% — the floor had been calibrated against an artifact of the
 * machine it was measured on.
 *
 * LF IS THE AUTHORITATIVE FIGURE, because that is what CI and every Linux
 * contributor sees. `.gitattributes` now pins `*.sol` to LF so a Windows checkout
 * agrees too. Any future reading should be taken from a tree that has been
 * re-checked out under those attributes — not from a long-lived Windows working
 * tree, which will read optimistically high.
 *
 * 88% sits a point under the LF-measured 89.22%, for the same reason as before:
 * a floor at the current number fails on the next unrelated refactor and gets
 * deleted, while one a point down still catches a real regression. Raising it is
 * the goal; `SafeCast.sol` at 50% and the revert branches in `Vault` and
 * `PythOracleAdapter` are where the missing lines are.
 */
const MIN_LINE_PCT = 88;
/** Only enforced when the report actually carries branch records. */
const MIN_BRANCH_PCT = 76;

interface FileCoverage {
  path: string;
  linesFound: number;
  linesHit: number;
  branchesFound: number;
  branchesHit: number;
}

/** Parse the subset of lcov this needs: SF, LF, LH, BRF, BRH per record. */
function parseLcov(text: string): FileCoverage[] {
  const out: FileCoverage[] = [];
  let current: Partial<FileCoverage> | null = null;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "SF:") {
      continue;
    }
    if (line.startsWith("SF:")) {
      current = { path: line.slice(3).replace(/\\/g, "/") };
      continue;
    }
    if (!current) continue;

    if (line.startsWith("LF:")) current.linesFound = Number(line.slice(3));
    else if (line.startsWith("LH:")) current.linesHit = Number(line.slice(3));
    else if (line.startsWith("BRF:")) current.branchesFound = Number(line.slice(4));
    else if (line.startsWith("BRH:")) current.branchesHit = Number(line.slice(4));
    else if (line === "end_of_record") {
      if (current.path) {
        out.push({
          path: current.path,
          linesFound: current.linesFound ?? 0,
          linesHit: current.linesHit ?? 0,
          branchesFound: current.branchesFound ?? 0,
          branchesHit: current.branchesHit ?? 0,
        });
      }
      current = null;
    }
  }
  return out;
}

/** True when `path` ends with one of the included prefixes. */
function isIncluded(path: string): boolean {
  return INCLUDED_PREFIXES.some((p) => path.endsWith(p));
}

/**
 * Percentage, or null when there is nothing to measure.
 *
 * Returning null rather than 100 for an empty denominator is the whole reason
 * this function is not a one-liner: dividing by zero and calling it 100 produced
 * a "branches 100.00%" line on a report that carried no branch data at all.
 */
function pct(hit: number, found: number): number | null {
  return found === 0 ? null : (hit / found) * 100;
}

/** Format a percentage for the table, or `n/a` when there is nothing to measure. */
function fmt(p: number | null): string {
  return p === null ? "   n/a" : `${p.toFixed(2).padStart(6)}%`;
}

function main(): void {
  const lcovPath = resolve(process.cwd(), "coverage/lcov.info");
  if (!existsSync(lcovPath)) {
    console.error(
      `\nNo coverage report at ${lcovPath}.\n` +
        `Run it first:  npx hardhat test --coverage\n`
    );
    process.exitCode = 1;
    return;
  }

  const all = parseLcov(readFileSync(lcovPath, "utf8"));
  const included = all.filter((f) => isIncluded(f.path));

  if (included.length === 0) {
    // A silent pass here would be worse than a failure: it would mean the
    // lcov format changed and the gate stopped measuring anything.
    console.error(
      `\nCoverage gate matched no files. The lcov paths may have changed.\n` +
        `Looked for suffixes:\n  ${INCLUDED_PREFIXES.join("\n  ")}\n` +
        `Found ${all.length} records, e.g.:\n  ${all
          .slice(0, 5)
          .map((f) => f.path)
          .join("\n  ")}\n`
    );
    process.exitCode = 1;
    return;
  }

  const linesFound = included.reduce((n, f) => n + f.linesFound, 0);
  const linesHit = included.reduce((n, f) => n + f.linesHit, 0);
  const branchesFound = included.reduce((n, f) => n + f.branchesFound, 0);
  const branchesHit = included.reduce((n, f) => n + f.branchesHit, 0);

  const linePct = pct(linesHit, linesFound);
  const branchPct = pct(branchesHit, branchesFound);

  const label = (p: string) =>
    p.replace(/^.*contracts\/perp\//, "").padEnd(28, " ");
  const row = (p: string, l: number | null, b: number | null) =>
    `  ${label(p)} lines ${fmt(l)}   branches ${fmt(b)}`;

  console.log("\nPerp module coverage");
  console.log("─".repeat(64));
  for (const f of included) {
    console.log(row(f.path, pct(f.linesHit, f.linesFound), pct(f.branchesHit, f.branchesFound)));
  }
  console.log("─".repeat(64));
  console.log(`  ${"TOTAL".padEnd(28, " ")} lines ${fmt(linePct)}   branches ${fmt(branchPct)}`);
  console.log(
    `  ${"floor".padEnd(28, " ")} lines ${fmt(MIN_LINE_PCT)} (${MIN_LINE_PCT}%)   branches ${
      branchPct === null ? "   n/a (not gated)" : fmt(MIN_BRANCH_PCT)
    }`
  );

  const failures: string[] = [];
  if (linePct === null || linePct < MIN_LINE_PCT) {
    failures.push(`lines ${linePct === null ? "n/a" : linePct.toFixed(2) + "%"} < ${MIN_LINE_PCT}%`);
  }
  // Only enforced when branch data exists. A report with none must not pass a
  // branch check, but it also must not be scored as if it had.
  if (branchPct !== null && branchPct < MIN_BRANCH_PCT) {
    failures.push(`branches ${branchPct.toFixed(2)}% < ${MIN_BRANCH_PCT}%`);
  }
  if (branchPct === null) {
    console.log(
      `  note: no branch records in the report, so branch coverage is not gated.` +
        `\n        Hardhat 3 emits line data only.`
    );
  }

  if (failures.length > 0) {
    console.error(`\n✗ Coverage below floor: ${failures.join(", ")}\n`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n✓ Coverage above floor\n`);
}

main();
