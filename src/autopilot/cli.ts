import { approveCatalogAutopilot, loadCatalogAutopilotCheckpoint, prepareCatalogAutopilot } from "./orchestrator.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positionals[0];

  if (command === "prepare") {
    const checkpoint = await prepareCatalogAutopilot({
      vaultRoot: required(args.flags, "vault-root"),
      workspaceRoot: required(args.flags, "workspace"),
      runId: args.flags.get("run-id"),
      minTracks: optionalInteger(args.flags, "min-tracks"),
      maxTracks: optionalInteger(args.flags, "max-tracks"),
      excludedReleases: args.flags.get("exclude-release")?.split(",").map((item) => item.trim()).filter(Boolean)
    });
    printSummary(checkpoint);
    return;
  }

  if (command === "approve") {
    const checkpoint = await approveCatalogAutopilot({
      runDirectory: required(args.flags, "run"),
      proposalSha256: required(args.flags, "proposal-sha256")
    });
    printSummary(checkpoint);
    return;
  }

  if (command === "status") {
    const checkpoint = await loadCatalogAutopilotCheckpoint(required(args.flags, "run"));
    printSummary(checkpoint);
    return;
  }

  throw new Error("Usage: catalog-autopilot <prepare|approve|status> ...");
}

function printSummary(checkpoint: Awaited<ReturnType<typeof loadCatalogAutopilotCheckpoint>>): void {
  process.stdout.write(`${JSON.stringify({
    runId: checkpoint.runId,
    state: checkpoint.state,
    runDirectory: checkpoint.runDirectory,
    proposal: checkpoint.proposalBinding,
    decision: checkpoint.decisionBinding,
    plan: checkpoint.planBinding,
    refusal: checkpoint.refusal,
    lastError: checkpoint.lastError,
    stages: checkpoint.stages.map((stage) => ({ name: stage.name, status: stage.status }))
  }, null, 2)}\n`);
}

function parseArgs(argv: string[]): { positionals: string[]; flags: Map<string, string> } {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}.`);
    flags.set(key, value);
    index += 1;
  }
  return { positionals, flags };
}

function optionalInteger(flags: Map<string, string>, key: string): number | undefined {
  const value = flags.get(key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`--${key} must be an integer.`);
  return parsed;
}

function required(flags: Map<string, string>, key: string): string {
  const value = flags.get(key);
  if (!value) throw new Error(`Missing --${key}.`);
  return value;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
