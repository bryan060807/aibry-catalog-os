#!/usr/bin/env node
import { parseArgs } from "node:util";
import { executeGuardedLiveApply } from "./execute.js";
import { prepareGuardedLiveApply } from "./prepare.js";

async function main(argv: string[]): Promise<void> {
  const phase = argv[0];
  if (phase === "prepare") {
    const parsed = parseArgs({
      args: argv.slice(1), strict: true, allowPositionals: false,
      options: {
        "package-manifest": { type: "string" }, vault: { type: "string" }, "rollback-root": { type: "string" },
        "result-directory": { type: "string" }, output: { type: "string" }
      }
    });
    const plan = await prepareGuardedLiveApply({
      packageManifest: required(parsed.values["package-manifest"], "--package-manifest"),
      vaultRoot: required(parsed.values.vault, "--vault"),
      rollbackRoot: required(parsed.values["rollback-root"], "--rollback-root"),
      resultDirectory: required(parsed.values["result-directory"], "--result-directory"),
      outputPath: required(parsed.values.output, "--output")
    });
    process.stdout.write(`${JSON.stringify({ contract: plan.contract, state: plan.state, proposalId: plan.proposalId, planSha256: plan.planSha256, applyExecuted: false, next: "Review the exact plan hash, then run execute from an attached Windows console." }, null, 2)}\n`);
    return;
  }
  if (phase === "execute") {
    const parsed = parseArgs({ args: argv.slice(1), strict: true, allowPositionals: false, options: { plan: { type: "string" }, "expected-plan-sha256": { type: "string" } } });
    const report = await executeGuardedLiveApply(required(parsed.values.plan, "--plan"), required(parsed.values["expected-plan-sha256"], "--expected-plan-sha256"));
    process.stdout.write(`${JSON.stringify({ contract: report.contract, finalStatus: report.finalStatus, proposalId: report.proposalId, applyExecuted: report.applyExecuted, rollbackStatus: report.rollbackStatus }, null, 2)}\n`);
    process.exitCode = report.finalStatus === "applied-and-validated" ? 0 : 1;
    return;
  }
  throw new Error("Usage: guarded-live-apply prepare --package-manifest <path> --vault <path> --rollback-root <new-path> --result-directory <new-path> --output <plan.json> | guarded-live-apply execute --plan <plan.json> --expected-plan-sha256 <hash>");
}

function required(value: string | undefined, label: string): string { if (!value) throw new Error(`${label} is required.`); return value; }

main(process.argv.slice(2)).catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
