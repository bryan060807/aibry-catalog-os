import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { executeGuardedLiveApply } from "./execute.js";
import { loadAndVerifyGuardedPlan, prepareGuardedLiveApply } from "./prepare.js";
import type { GuardedPackagePolicy } from "./package-verifier.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positionals[0];
  if (command === "prepare") {
    const packagePolicy = (args.flags.get("package-policy") ?? "bounded-lyric-source-batch") as GuardedPackagePolicy;
    if (packagePolicy !== "bounded-lyric-source-batch" && packagePolicy !== "ground-wire-gospel-pilot") throw new Error(`Unsupported package policy: ${packagePolicy}`);
    const plan = await prepareGuardedLiveApply({
      packageManifest: required(args.flags, "package"),
      vaultRoot: required(args.flags, "vault-root"),
      rollbackRoot: required(args.flags, "rollback-root"),
      resultDirectory: required(args.flags, "result-dir"),
      outputPath: required(args.flags, "output"),
      packagePolicy
    });
    process.stdout.write(`${JSON.stringify({ status: "prepared", packagePolicy, proposalId: plan.proposalId, planSha256: plan.planSha256, output: required(args.flags, "output") }, null, 2)}\n`);
    return;
  }
  if (command === "execute") {
    const planPath = required(args.flags, "plan");
    const expectedSha256 = required(args.flags, "plan-sha256");
    const loaded = await loadAndVerifyGuardedPlan(planPath, expectedSha256);
    if (!args.switches.has("yes")) {
      const rl = createInterface({ input, output });
      const answer = await rl.question(`Execute guarded live APPLY for ${loaded.plan.proposalId}\nPlan SHA-256: ${loaded.plan.planSha256}\nType the full plan SHA-256 to authorize: `);
      rl.close();
      if (answer.trim() !== loaded.plan.planSha256) throw new Error("Interactive authorization did not match the exact guarded plan SHA-256.");
    }
    const result = await executeGuardedLiveApply({ planPath, expectedPlanSha256: expectedSha256 });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  throw new Error("Usage: guarded-live-apply <prepare|execute> ...");
}

function parseArgs(argv: string[]): { positionals: string[]; flags: Map<string, string>; switches: Set<string> } {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  const switches = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (key === "yes") {
      switches.add(key);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}.`);
    flags.set(key, value);
    index += 1;
  }
  return { positionals, flags, switches };
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
