import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sha256Bytes } from "../../src/kernel/canonical-json.js";
import { isLiveMusicVaultPath } from "../../src/kernel/contract-path.js";
import { buildReviewDecision, createLyricSourceHandoff } from "../../src/lyric-source/approval.js";
import { runLyricSourceApplyDryRun, type LyricSourceDryRunProgress } from "../../src/lyric-source/dry-run-specialist.js";
import { compileLyricSourceProposal } from "../../src/lyric-source/proposal-specialist.js";
import { compileWindowsApplyCandidate } from "../../src/lyric-source/windows-apply-builder.js";
import { materializeGoldenLyricFixture } from "./lyric-source-fixture.js";

const execFileAsync = promisify(execFile);
const OUTER_FIXTURE_TIMEOUT_MS = 8 * 60 * 1000;
const PROGRESS_PREFIX = "REPEATABILITY_PROGRESS ";
const RESULT_PREFIX = "REPEATABILITY_RESULT ";

type FixtureName = "black-box-psalms" | "the-violence-of-spring";

type RepeatabilityHashes = {
  proposalSha256: string;
  scriptSha256: string;
  dryRunReportSha256: string;
  decisionArtifactSha256: string;
  handoffArtifactSha256: string;
};

type RepeatabilityRunResult = RepeatabilityHashes & {
  fixture: FixtureName;
  run: 1 | 2;
  operationCount: number;
  powerShellVersion: string;
  clrVersion: string;
  evidenceDirectory: string;
  elapsedMs: number;
};

type RepeatabilitySummary = {
  contract: "lyric-source-repeatability-summary.v1";
  outerTimeoutMs: number;
  evidenceDirectory: string;
  runs: RepeatabilityRunResult[];
  comparisons: Array<{ fixture: FixtureName; allHashesMatch: boolean; hashes: Record<keyof RepeatabilityHashes, boolean> }>;
};

async function main(): Promise<void> {
  try {
    if (process.argv[2] === "--child") {
      await runFixtureChild(parseChildArguments(process.argv.slice(3)));
      return;
    }
    await runSequentialParent();
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

async function runSequentialParent(): Promise<void> {
  const sessionRoot = await mkdtemp(path.join(os.tmpdir(), "catalog-lyric-repeatability-"));
  process.stdout.write(`${PROGRESS_PREFIX}${JSON.stringify({ stage: "session", state: "created", evidenceDirectory: sessionRoot, outerTimeoutMs: OUTER_FIXTURE_TIMEOUT_MS })}\n`);
  const sequence: Array<{ fixture: FixtureName; run: 1 | 2 }> = [
    { fixture: "black-box-psalms", run: 1 },
    { fixture: "black-box-psalms", run: 2 },
    { fixture: "the-violence-of-spring", run: 1 },
    { fixture: "the-violence-of-spring", run: 2 }
  ];
  const runs: RepeatabilityRunResult[] = [];
  const comparisons: RepeatabilitySummary["comparisons"] = [];
  for (const item of sequence) {
    const evidenceDirectory = path.join(sessionRoot, `${item.fixture}-run-${item.run}`);
    await mkdir(evidenceDirectory);
    const result = await runFixtureProcess(item.fixture, item.run, evidenceDirectory);
    runs.push(result);
    if (item.run === 2) {
      const first = runs.find((candidate) => candidate.fixture === item.fixture && candidate.run === 1);
      if (!first) throw new Error(`Repeatability ${item.fixture} run 1 result is missing.`);
      const hashes = compareHashes(first, result);
      const allHashesMatch = Object.values(hashes).every(Boolean);
      comparisons.push({ fixture: item.fixture, allHashesMatch, hashes });
      process.stdout.write(`${PROGRESS_PREFIX}${JSON.stringify({ stage: "comparison", fixture: item.fixture, state: allHashesMatch ? "matched" : "mismatch", hashes })}\n`);
      if (!allHashesMatch) throw new Error(`Repeatability hash mismatch for ${item.fixture}; evidence preserved at ${sessionRoot}.`);
    }
  }
  const summary: RepeatabilitySummary = {
    contract: "lyric-source-repeatability-summary.v1",
    outerTimeoutMs: OUTER_FIXTURE_TIMEOUT_MS,
    evidenceDirectory: sessionRoot,
    runs,
    comparisons
  };
  const summaryPath = path.join(sessionRoot, "repeatability-summary.v1.json");
  await writeJson(summaryPath, summary);
  process.stdout.write(`${PROGRESS_PREFIX}${JSON.stringify({ stage: "summary", state: "finalized", summaryPath })}\n`);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

async function runFixtureProcess(fixture: FixtureName, run: 1 | 2, evidenceDirectory: string): Promise<RepeatabilityRunResult> {
  const entry = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [entry, "--child", "--fixture", fixture, "--run", String(run), "--evidence", evidenceDirectory], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdoutRemainder = "";
  let stderrRemainder = "";
  let result: RepeatabilityRunResult | null = null;
  let lastStage = "child-launch";
  const processLine = (line: string, stderr: boolean) => {
    if (line.length === 0) return;
    (stderr ? process.stderr : process.stdout).write(`${line}\n`);
    if (line.startsWith(PROGRESS_PREFIX)) lastStage = line.slice(PROGRESS_PREFIX.length);
    if (line.startsWith(RESULT_PREFIX)) result = JSON.parse(line.slice(RESULT_PREFIX.length)) as RepeatabilityRunResult;
  };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    const parsed = splitLines(stdoutRemainder + chunk);
    stdoutRemainder = parsed.remainder;
    for (const line of parsed.lines) processLine(line, false);
  });
  child.stderr?.on("data", (chunk: string) => {
    const parsed = splitLines(stderrRemainder + chunk);
    stderrRemainder = parsed.remainder;
    for (const line of parsed.lines) processLine(line, true);
  });
  await waitForBoundedChild(child, fixture, run, () => lastStage);
  processLine(stdoutRemainder, false);
  processLine(stderrRemainder, true);
  if (!result) throw new Error(`Repeatability ${fixture} run ${run} exited without a result; last stage: ${lastStage}; evidence preserved at ${evidenceDirectory}.`);
  return result;
}

async function waitForBoundedChild(child: ChildProcess, fixture: FixtureName, run: 1 | 2, lastStage: () => string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      void terminateProcessTree(child).then(
        () => finish(() => reject(new Error(`Repeatability ${fixture} run ${run} exceeded ${OUTER_FIXTURE_TIMEOUT_MS} ms; last stage: ${lastStage()}.`))),
        (error: unknown) => finish(() => reject(error))
      );
    }, OUTER_FIXTURE_TIMEOUT_MS);
    child.once("error", (error) => finish(() => reject(new Error(`Repeatability ${fixture} run ${run} launch failed at ${lastStage()}: ${error.message}`))));
    child.once("close", (code, signal) => finish(() => {
      if (code === 0) resolve();
      else reject(new Error(`Repeatability ${fixture} run ${run} exited with code ${String(code)} signal ${String(signal)}; last stage: ${lastStage()}.`));
    }));
  });
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid) throw new Error("Repeatability timeout occurred before the child PID was available.");
  const pid = child.pid;
  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 });
    } catch (error: unknown) {
      if (processExists(pid)) throw new Error(`Repeatability child process tree ${pid} survived timeout handling: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    child.kill("SIGKILL");
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (processExists(pid)) throw new Error(`Repeatability child process ${pid} survived timeout handling.`);
}

async function runFixtureChild(input: { fixture: FixtureName; run: 1 | 2; evidenceDirectory: string }): Promise<void> {
  const startedAt = Date.now();
  assertTemporaryEvidencePath(input.evidenceDirectory);
  emitChildProgress(input, { stage: "fixture", state: "start", evidenceDirectory: input.evidenceDirectory });
  const materialized = await materializeGoldenLyricFixture(input.fixture, input.evidenceDirectory);
  const proposal = compileLyricSourceProposal(materialized.input);
  const proposalBytes = Buffer.from(`${JSON.stringify(proposal, null, 2)}\n`, "utf8");
  const proposalPath = path.join(input.evidenceDirectory, "lyric-source-designation-proposal.v1.json");
  await writeFile(proposalPath, proposalBytes);
  emitChildProgress(input, { stage: "proposal", state: "generated", sha256: proposal.proposalSha256 });

  const decision = buildReviewDecision(proposal.proposalId, proposal.proposalSha256, "approved", proposal.generatedAt);
  const decisionBytes = Buffer.from(`${JSON.stringify(decision, null, 2)}\n`, "utf8");
  const decisionPath = path.join(input.evidenceDirectory, "asos-authority-decision.v1.json");
  await writeFile(decisionPath, decisionBytes);
  emitChildProgress(input, { stage: "decision", state: "generated", sha256: sha256Bytes(decisionBytes) });

  const script = compileWindowsApplyCandidate(proposal, decision);
  const scriptPath = path.join(input.evidenceDirectory, "lyric-source-windows-apply.v1.ps1");
  await writeFile(scriptPath, script.content, "utf8");
  emitChildProgress(input, { stage: "script", state: "generated", sha256: script.sha256 });

  let clrVersion = "unknown";
  const dryRun = await runLyricSourceApplyDryRun(proposalPath, scriptPath, materialized.vault, proposal.generatedAt, {
    onProgress: (progress) => {
      if (progress.stage === "powershell-probe" && progress.state === "finish" && progress.probe === "version") clrVersion = progress.clrVersion;
      emitChildProgress(input, progress);
    }
  });
  if (dryRun.status !== "passed" || dryRun.failures.length !== 0) {
    throw new Error(`Repeatability ${input.fixture} run ${input.run} produced an unexpected dry-run result: ${dryRun.failures.join("; ")}`);
  }
  const dryRunBytes = Buffer.from(`${JSON.stringify(dryRun, null, 2)}\n`, "utf8");
  const dryRunPath = path.join(input.evidenceDirectory, "lyric-source-apply-dry-run-report.v1.json");
  await writeFile(dryRunPath, dryRunBytes);
  emitChildProgress(input, { stage: "dry-run", state: "completed", sha256: sha256Bytes(dryRunBytes) });

  const handoff = createLyricSourceHandoff(proposal, decision, script.sha256, dryRun, sha256Bytes(dryRunBytes), sha256Bytes(proposalBytes));
  const handoffBytes = Buffer.from(`${JSON.stringify(handoff, null, 2)}\n`, "utf8");
  const handoffPath = path.join(input.evidenceDirectory, "lyric-source-apply-handoff.v1.json");
  await writeFile(handoffPath, handoffBytes);
  emitChildProgress(input, { stage: "handoff", state: "generated", sha256: sha256Bytes(handoffBytes) });

  const result: RepeatabilityRunResult = {
    fixture: input.fixture,
    run: input.run,
    operationCount: proposal.operations.length,
    proposalSha256: proposal.proposalSha256,
    scriptSha256: script.sha256,
    dryRunReportSha256: sha256Bytes(dryRunBytes),
    decisionArtifactSha256: sha256Bytes(decisionBytes),
    handoffArtifactSha256: sha256Bytes(handoffBytes),
    powerShellVersion: dryRun.powerShellVersion,
    clrVersion,
    evidenceDirectory: input.evidenceDirectory,
    elapsedMs: Date.now() - startedAt
  };
  await writeJson(path.join(input.evidenceDirectory, "repeatability-run-result.v1.json"), result);
  emitChildProgress(input, { stage: "hashes", state: "finalized", hashes: selectHashes(result) });
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`);
}

function parseChildArguments(args: string[]): { fixture: FixtureName; run: 1 | 2; evidenceDirectory: string } {
  const fixture = valueAfter(args, "--fixture");
  const runText = valueAfter(args, "--run");
  const evidenceDirectory = valueAfter(args, "--evidence");
  if (fixture !== "black-box-psalms" && fixture !== "the-violence-of-spring") throw new Error(`Unknown repeatability fixture: ${fixture}`);
  if (runText !== "1" && runText !== "2") throw new Error(`Repeatability run must be 1 or 2, got ${runText}.`);
  return { fixture, run: runText === "1" ? 1 : 2, evidenceDirectory: path.resolve(evidenceDirectory) };
}

function valueAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`Missing repeatability argument ${flag}.`);
  return value;
}

function compareHashes(left: RepeatabilityHashes, right: RepeatabilityHashes): Record<keyof RepeatabilityHashes, boolean> {
  return {
    proposalSha256: left.proposalSha256 === right.proposalSha256,
    scriptSha256: left.scriptSha256 === right.scriptSha256,
    dryRunReportSha256: left.dryRunReportSha256 === right.dryRunReportSha256,
    decisionArtifactSha256: left.decisionArtifactSha256 === right.decisionArtifactSha256,
    handoffArtifactSha256: left.handoffArtifactSha256 === right.handoffArtifactSha256
  };
}

function selectHashes(result: RepeatabilityRunResult): RepeatabilityHashes {
  return {
    proposalSha256: result.proposalSha256,
    scriptSha256: result.scriptSha256,
    dryRunReportSha256: result.dryRunReportSha256,
    decisionArtifactSha256: result.decisionArtifactSha256,
    handoffArtifactSha256: result.handoffArtifactSha256
  };
}

function emitChildProgress(input: { fixture: FixtureName; run: 1 | 2 }, progress: LyricSourceDryRunProgress | Record<string, unknown>): void {
  process.stdout.write(`${PROGRESS_PREFIX}${JSON.stringify({ fixture: input.fixture, run: input.run, ...progress })}\n`);
}

function splitLines(value: string): { lines: string[]; remainder: string } {
  const parts = value.split(/\r?\n/);
  return { lines: parts.slice(0, -1), remainder: parts.at(-1) ?? "" };
}

function assertTemporaryEvidencePath(candidate: string): void {
  if (isLiveMusicVaultPath(candidate)) throw new Error("Repeatability evidence path resolves to the live Music Vault.");
  const relative = path.relative(os.tmpdir(), candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Repeatability evidence must remain below the OS temporary root: ${candidate}`);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryPath === path.resolve(fileURLToPath(import.meta.url))) void main();
