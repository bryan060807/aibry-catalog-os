import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AdmissionReport } from "../src/catalog/admit.js";
import { main } from "../src/cli.js";
import { renderAdmissionReport } from "../src/reports/admission-report.js";

test("project admit defaults to PROPOSE and reports only unambiguous candidates as WOULD_ADMIT", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "catalog-admit-"));
  const vault = path.join(workspace, "vault");
  const output = path.join(workspace, "admission.md");
  const eligible = path.join(vault, "project-memory", "music", "singles", "Eligible Song");
  const ambiguous = path.join(vault, "project-memory", "music", "singles", "Ambiguous Song");
  const existing = path.join(vault, "project-memory", "music", "singles", "Existing Song");
  try {
    await setupVault(vault);
    await mkdir(path.join(eligible, "lyrics"), { recursive: true });
    await mkdir(path.join(ambiguous, "lyrics"), { recursive: true });
    await mkdir(existing, { recursive: true });
    await writeFile(path.join(eligible, "lyrics", "eligible.md"), "# Lyric\n", "utf8");
    await writeFile(path.join(ambiguous, "lyrics", "one.md"), "# One\n", "utf8");
    await writeFile(path.join(ambiguous, "lyrics", "two.md"), "# Two\n", "utf8");
    await writeFile(path.join(existing, "project.md"), "# Existing\n", "utf8");

    await main(["catalog", "admit", "--vault", vault, "--output", output]);
    const report = await readFile(output, "utf8");
    await assert.rejects(() => stat(path.join(eligible, "project.md")), { code: "ENOENT" });
    assert.match(report, /SPECIALIST: Project Admitter/);
    assert.match(report, /Specialist Version: v2/);
    assert.match(report, /Operational Standard: ASOS v1/);
    assert.match(report, /Run ID: [0-9a-f-]{36}/);
    assert.match(report, /Mode: PROPOSE/);
    assert.match(report, /Duration: \d+ms/);
    assert.match(report, /ERROR: 0/);
    assert.match(report, /WOULD_ADMIT — `project-memory[\\/]music[\\/]singles[\\/]Eligible Song`/);
    assert.match(report, /Selected lyric source: project-memory[\\/]music[\\/]singles[\\/]Eligible Song[\\/]lyrics[\\/]eligible\.md/);
    assert.match(report, /- Status: WOULD_ADMIT/);
    assert.match(report, /- Subject: `project-memory[\\/]music[\\/]singles[\\/]Eligible Song`/);
    assert.match(report, /- Recommendation: Review this proposal\./);
    assert.doesNotMatch(report, /- Result:/);
    assert.doesNotMatch(report, /## Execution Summary/);
    assert.match(report, /NEEDS_REVIEW — `project-memory[\\/]music[\\/]singles[\\/]Ambiguous Song`/);
    assert.match(report, /SKIPPED — `project-memory[\\/]music[\\/]singles[\\/]Existing Song`/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("project admit keeps --dry-run as proposal-only behavior", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "catalog-admit-"));
  const vault = path.join(workspace, "vault");
  const output = path.join(workspace, "admission.md");
  const eligible = path.join(vault, "project-memory", "music", "singles", "Dry Run Song");
  try {
    await setupVault(vault);
    await mkdir(path.join(eligible, "lyrics"), { recursive: true });
    await writeFile(path.join(eligible, "lyrics", "dry-run.md"), "# Lyric\n", "utf8");

    await main(["catalog", "admit", "--vault", vault, "--output", output, "--dry-run"]);
    const report = await readFile(output, "utf8");
    assert.match(report, /Mode: PROPOSE/);
    assert.match(report, /- Recommendation: Review this proposal\./);
    assert.doesNotMatch(report, /- Attempted:|- Result:|## Execution Summary/);
    await assert.rejects(() => stat(path.join(eligible, "project.md")), { code: "ENOENT" });
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("project admit recognizes only one approved central lyric and excludes central documentation", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "catalog-admit-"));
  const vault = path.join(workspace, "vault");
  const output = path.join(workspace, "admission.md");
  const track = path.join(vault, "project-memory", "music", "albums", "cassette-tapes", "07-ashes-to-armor");
  const centralLyrics = path.join(vault, "lyrics", "albums", "the-cassette-tapes");
  try {
    await setupVault(vault);
    await mkdir(track, { recursive: true });
    await mkdir(centralLyrics, { recursive: true });
    await writeFile(path.join(centralLyrics, "07.ashes-to-armor.md"), "# Lyric\n", "utf8");
    await writeFile(path.join(centralLyrics, "README.md"), "# Documentation\n", "utf8");
    await writeFile(path.join(centralLyrics, "07-notes.md"), "# Notes\n", "utf8");

    await main(["catalog", "admit", "--vault", vault, "--output", output]);
    const report = await readFile(output, "utf8");
    await assert.rejects(() => stat(path.join(track, "project.md")), { code: "ENOENT" });
    assert.match(report, /WOULD_ADMIT — `project-memory[\\/]music[\\/]albums[\\/]cassette-tapes[\\/]07-ashes-to-armor`/);
    assert.match(report, /Selected lyric source: lyrics[\\/]albums[\\/]the-cassette-tapes[\\/]07\.ashes-to-armor\.md/);
    assert.doesNotMatch(report, /README\.md|07-notes\.md/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("project admit labels an explicit observation run with OBSERVE mode", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "catalog-admit-"));
  const vault = path.join(workspace, "vault");
  const output = path.join(workspace, "admission.md");
  const eligible = path.join(vault, "project-memory", "music", "singles", "Observed Song");
  try {
    await setupVault(vault);
    await mkdir(path.join(eligible, "lyrics"), { recursive: true });
    await writeFile(path.join(eligible, "lyrics", "observed.md"), "# Lyric\n", "utf8");

    await main(["catalog", "admit", "--vault", vault, "--output", output, "--observe"]);
    const report = await readFile(output, "utf8");
    assert.match(report, /Mode: OBSERVE/);
    assert.match(report, /WOULD_ADMIT/);
    await assert.rejects(() => stat(path.join(eligible, "project.md")), { code: "ENOENT" });
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("project admit keeps review status when approved central lyric matches are absent or ambiguous", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "catalog-admit-"));
  const vault = path.join(workspace, "vault");
  const output = path.join(workspace, "admission.md");
  const missing = path.join(vault, "project-memory", "music", "singles", "Missing Song");
  const ambiguous = path.join(vault, "project-memory", "music", "albums", "black-box-psalms", "02-foreign-body");
  const centralLyrics = path.join(vault, "lyrics", "albums", "black-box-psalms");
  const centralSingles = path.join(vault, "lyrics", "singles");
  try {
    await setupVault(vault);
    await mkdir(missing, { recursive: true });
    await mkdir(ambiguous, { recursive: true });
    await mkdir(centralLyrics, { recursive: true });
    await mkdir(centralSingles, { recursive: true });
    await writeFile(path.join(centralSingles, "missing song.md"), Buffer.from([0xc3, 0x28]));
    await writeFile(path.join(centralLyrics, "02-foreign-body.md"), "# First\n", "utf8");
    await writeFile(path.join(centralLyrics, "02.alternate.md"), "# Second\n", "utf8");

    await main(["catalog", "admit", "--vault", vault, "--output", output]);
    const report = await readFile(output, "utf8");
    assert.match(report, /NEEDS_REVIEW — `project-memory[\\/]music[\\/]singles[\\/]Missing Song`/);
    assert.match(report, /No approved UTF-8 Markdown lyric source remained after exclusions\./);
    assert.match(report, /NEEDS_REVIEW — `project-memory[\\/]music[\\/]albums[\\/]black-box-psalms[\\/]02-foreign-body`/);
    assert.match(report, /More than one approved lyric source was observed\./);
    assert.match(report, /Observed lyric source: lyrics[\\/]albums[\\/]black-box-psalms[\\/]02-foreign-body\.md/);
    assert.match(report, /Observed lyric source: lyrics[\\/]albums[\\/]black-box-psalms[\\/]02\.alternate\.md/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("project admit apply creates only the eligible missing front door and never overwrites", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "catalog-admit-"));
  const vault = path.join(workspace, "vault");
  const output = path.join(workspace, "admission.md");
  const eligible = path.join(vault, "project-memory", "music", "singles", "Eligible Song");
  const ambiguous = path.join(vault, "project-memory", "music", "singles", "Ambiguous Song");
  const existing = path.join(vault, "project-memory", "music", "singles", "Existing Song");
  try {
    await setupVault(vault);
    await mkdir(path.join(eligible, "lyrics"), { recursive: true });
    await mkdir(path.join(ambiguous, "lyrics"), { recursive: true });
    await mkdir(existing, { recursive: true });
    await writeFile(path.join(eligible, "lyrics", "eligible.md"), "# Lyric\n", "utf8");
    await writeFile(path.join(ambiguous, "lyrics", "one.md"), "# One\n", "utf8");
    await writeFile(path.join(ambiguous, "lyrics", "two.md"), "# Two\n", "utf8");
    await writeFile(path.join(existing, "project.md"), "# Preserve Me\n", "utf8");

    await main(["catalog", "admit", "--vault", vault, "--output", output, "--apply"]);
    const created = await readFile(path.join(eligible, "project.md"), "utf8");
    assert.match(created, /^# Eligible Song/m);
    assert.match(created, /lyrics[\\/]eligible\.md/);
    assert.equal(await readFile(path.join(existing, "project.md"), "utf8"), "# Preserve Me\n");
    const report = await readFile(output, "utf8");
    assert.match(report, /Mode: APPLY/);
    assert.match(report, /- WOULD_ADMIT: 0/);
    assert.match(report, /- ADMITTED: 1/);
    assert.match(report, /- SKIPPED: 1/);
    assert.match(report, /- NEEDS_REVIEW: 1/);
    assert.match(report, /- ERROR: 0/);
    assert.match(report, /## Execution Summary/);
    assert.match(report, /- Attempted: 1/);
    assert.match(report, /- Succeeded: 1/);
    assert.match(report, /- Failed: 0/);
    assert.match(report, /- Skipped without attempt: 1/);
    assert.match(report, /- Remained unverified: 1/);
    assert.match(report, /ADMITTED — `project-memory[\\/]music[\\/]singles[\\/]Eligible Song`/);
    assert.match(report, /- Attempted: Yes/);
    assert.match(report, /- Result: Succeeded: created and verified a new direct regular project\.md file\./);
    assert.doesNotMatch(report, /- Recommendation: Review this proposal\./);
    const admittedFinding = report.match(/### ADMITTED[\s\S]*?(?=\n### |\n## Mutation Record)/)?.[0];
    assert.ok(admittedFinding);
    assert.doesNotMatch(admittedFinding, /- Recommendation:/);
    const skippedFinding = report.match(/### SKIPPED[\s\S]*?(?=\n### |\n## Mutation Record)/)?.[0];
    assert.ok(skippedFinding);
    assert.match(skippedFinding, /- Attempted: No/);
    assert.match(skippedFinding, /- Result: Skipped: no mutation was attempted/);
    const unverifiedFinding = report.match(/### NEEDS_REVIEW[\s\S]*?(?=\n### |\n## Mutation Record)/)?.[0];
    assert.ok(unverifiedFinding);
    assert.match(unverifiedFinding, /- Attempted: No/);
    assert.match(unverifiedFinding, /- Result: Unverified: no mutation was attempted/);
    assert.doesNotMatch(report, /- Recommendation:/);
    assert.match(report, /Created and verified: `project-memory[\\/]music[\\/]singles[\\/]Eligible Song[\\/]project\.md`/);
    assert.match(report, /This final report includes successful mutations and any execution errors/);

    await main(["catalog", "admit", "--vault", vault, "--output", output]);
    assert.match(await readFile(output, "utf8"), /SKIPPED — `project-memory[\\/]music[\\/]singles[\\/]Eligible Song`/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("project admit APPLY rendering labels attempted failures and recovery separately", () => {
  const report: AdmissionReport = {
    vaultPath: "fixture-vault",
    specialist: "Project Admitter",
    specialistVersion: "v2",
    operationalStandardVersion: "ASOS v1",
    runId: "00000000-0000-4000-8000-000000000000",
    mode: "APPLY",
    started: "2026-07-21T00:00:00.000Z",
    completed: "2026-07-21T00:00:01.000Z",
    durationMs: 1000,
    entries: [{
      status: "ERROR",
      attempted: true,
      relativePath: "project-memory/music/singles/Failed Song",
      projectRelativePath: "project-memory/music/singles/Failed Song/project.md",
      evidence: ["Selected lyric source: lyrics/singles/Failed Song.md"],
      result: "Failed: creation was attempted, but no admission was confirmed: simulated exclusive-write failure",
      recovery: "Inspect the target state before retrying."
    }],
    safeguards: []
  };

  const rendered = renderAdmissionReport(report);
  assert.match(rendered, /- Attempted: 1/);
  assert.match(rendered, /- Failed: 1/);
  assert.match(rendered, /- Attempted: Yes/);
  assert.match(rendered, /- Result: Failed: creation was attempted/);
  assert.match(rendered, /- Recovery: Inspect the target state before retrying\./);
  assert.doesNotMatch(rendered, /- Recommendation:/);
});

async function setupVault(vault: string): Promise<void> {
  await mkdir(path.join(vault, "instructions"), { recursive: true });
  await mkdir(path.join(vault, "project-memory", "music", "singles"), { recursive: true });
  await writeFile(path.join(vault, "instructions", "catalog-structure.md"), "# Structure\n", "utf8");
}
