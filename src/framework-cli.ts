import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { stageArtifact, verifyArtifact } from "./artifacts/handoff-specialist.js";
import { describeSpecialist, listSpecialists } from "./specialists/registry.js";
import { buildWindowsLyricSourceApplyWorkflow, dryRunLyricSourceApplyWorkflow, materializeLyricSourceCompatibilityFixtureWorkflow, planLyricSourceMigrationWorkflow, scoutLyricSourceBatchWorkflow, validateLyricSourceApplyWorkflow } from "./lyric-source/workflows.js";

export async function handleFrameworkCommand(argv: string[]): Promise<boolean> {
  if (argv[0] !== "catalog") {
    return false;
  }
  if (argv[1] === "specialist") {
    await handleSpecialist(argv.slice(2));
    return true;
  }
  if (argv[1] === "artifact") {
    await handleArtifact(argv.slice(2));
    return true;
  }
  if (argv[1] === "workflow" && isLyricWorkflow(argv[2])) {
    await handleLyricWorkflow(argv.slice(2));
    return true;
  }
  return false;
}

function parseOptions(args: string[], names: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: Object.fromEntries(names.map((name) => [name, { type: "string" as const }]))
  });
}

async function handleSpecialist(args: string[]): Promise<void> {
  if (args[0] === "list" && args.length === 1) {
    process.stdout.write(`${JSON.stringify({ contract: "specialist-registry.v1", specialists: listSpecialists() }, null, 2)}\n`);
    return;
  }
  if (args[0] === "describe" && args.length === 2 && args[1]) {
    const manifest = describeSpecialist(args[1]);
    if (!manifest) {
      throw new Error(`Unknown specialist: ${args[1]}`);
    }
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }
  throw new Error("Usage: catalog specialist list | catalog specialist describe <specialist-id>");
}

async function handleArtifact(args: string[]): Promise<void> {
  const parsed = parseOptions(args, ["file", "destination", "expected-contract", "expected-sha256", "output"]);
  const action = parsed.positionals[0];
  const file = requireOption(parsed.values.file, "--file");
  const contract = requireOption(parsed.values["expected-contract"], "--expected-contract");
  const sha256 = requireOption(parsed.values["expected-sha256"], "--expected-sha256");
  const report = action === "verify"
    ? await verifyArtifact(file, contract, sha256)
    : action === "stage"
      ? await stageArtifact(file, requireOption(parsed.values.destination, "--destination"), contract, sha256)
      : null;
  if (!report) {
    throw new Error("Usage: catalog artifact verify|stage --file <path> --expected-contract <contract> --expected-sha256 <hash> [--destination <path>] [--output <path>]");
  }
  if (parsed.values.output) {
    const output = path.resolve(parsed.values.output);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  } else {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
}

async function handleLyricWorkflow(args: string[]): Promise<void> {
  const name = args[0];
  if (name === "scout-lyric-source-batch") {
    const parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        vault: { type: "string" },
        "refresh-report": { type: "string" },
        "output-directory": { type: "string" },
        "min-tracks": { type: "string" },
        "max-tracks": { type: "string" },
        "exclude-release": { type: "string", multiple: true }
      }
    });
    const result = await scoutLyricSourceBatchWorkflow({
      vaultRoot: requireOption(parsed.values.vault, "--vault"),
      refreshReportPath: requireOption(parsed.values["refresh-report"], "--refresh-report"),
      outputDirectory: requireOption(parsed.values["output-directory"], "--output-directory"),
      minTracks: optionalInteger(parsed.values["min-tracks"], "--min-tracks"),
      maxTracks: optionalInteger(parsed.values["max-tracks"], "--max-tracks"),
      excludedReleases: parsed.values["exclude-release"]
    });
    process.stdout.write(`${JSON.stringify({
      status: result.report.refusal ? "refused" : "passed",
      reportPath: result.reportPath,
      planningInputPath: result.planningInputPath,
      workflowPath: result.workflowPath,
      refusal: result.report.refusal
    }, null, 2)}\n`);
    return;
  }
  if (name === "plan-lyric-source-migration") {
    const parsed = parseOptions(args, ["input", "output"]);
    await planLyricSourceMigrationWorkflow(requireOption(parsed.values.input, "--input"), requireOption(parsed.values.output, "--output"));
    return;
  }
  if (name === "materialize-lyric-source-compatibility-fixture") {
    const parsed = parseOptions(args, ["scout-report", "planning-input", "proposal", "decision", "output-directory"]);
    const result = await materializeLyricSourceCompatibilityFixtureWorkflow({
      scoutReportPath: requireOption(parsed.values["scout-report"], "--scout-report"),
      planningInputPath: requireOption(parsed.values["planning-input"], "--planning-input"),
      proposalPath: requireOption(parsed.values.proposal, "--proposal"),
      decisionPath: requireOption(parsed.values.decision, "--decision"),
      outputDirectory: requireOption(parsed.values["output-directory"], "--output-directory")
    });
    process.stdout.write(`${JSON.stringify({
      status: "passed",
      fixtureRoot: result.fixtureRoot,
      manifestPath: result.manifestPath,
      workflowPath: result.workflowPath,
      fixtureSnapshotSha256: result.manifest.fixtureSnapshotSha256,
      materializedFileCount: result.manifest.materializedFiles.length,
      applyExecuted: false
    }, null, 2)}\n`);
    return;
  }
  if (name === "dry-run-lyric-source-apply") {
    const parsed = parseOptions(args, ["proposal", "script", "fixture-vault", "output", "decision"]);
    await dryRunLyricSourceApplyWorkflow(requireOption(parsed.values.proposal, "--proposal"), requireOption(parsed.values.script, "--script"), requireOption(parsed.values["fixture-vault"], "--fixture-vault"), requireOption(parsed.values.output, "--output"), parsed.values.decision);
    return;
  }
  if (name === "build-windows-lyric-source-apply") {
    const parsed = parseOptions(args, ["proposal", "approval", "fixture-vault", "dry-run-report", "output"]);
    await buildWindowsLyricSourceApplyWorkflow(requireOption(parsed.values.proposal, "--proposal"), requireOption(parsed.values.approval, "--approval"), requireOption(parsed.values["fixture-vault"], "--fixture-vault"), requireOption(parsed.values["dry-run-report"], "--dry-run-report"), requireOption(parsed.values.output, "--output"));
    return;
  }
  if (name === "validate-lyric-source-apply") {
    const parsed = parseOptions(args, ["proposal", "vault", "snapshot", "workflow-report", "output", "generated-at"]);
    await validateLyricSourceApplyWorkflow(requireOption(parsed.values.proposal, "--proposal"), requireOption(parsed.values.vault, "--vault"), requireOption(parsed.values.snapshot, "--snapshot"), requireOption(parsed.values["workflow-report"], "--workflow-report"), requireOption(parsed.values.output, "--output"), requireOption(parsed.values["generated-at"], "--generated-at"));
    return;
  }
  throw new Error(`Unknown lyric-source workflow: ${String(name)}`);
}

function requireOption(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function optionalInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer.`);
  return Number.parseInt(value, 10);
}

function isLyricWorkflow(value: string | undefined): boolean {
  return value === "scout-lyric-source-batch" || value === "plan-lyric-source-migration" || value === "materialize-lyric-source-compatibility-fixture" || value === "build-windows-lyric-source-apply" || value === "dry-run-lyric-source-apply" || value === "validate-lyric-source-apply";
}
