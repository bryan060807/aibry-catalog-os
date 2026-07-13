#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { discoverCatalog } from "./catalog/discover.js";
import { auditCatalog } from "./catalog/audit.js";
import { admitProjects } from "./catalog/admit.js";
import type { AdmissionMode } from "./catalog/admit.js";
import { assertOutputOutsideVault, assertVaultDirectory } from "./policy/source-of-truth.js";
import { renderDiscoveryReport } from "./reports/discovery-report.js";
import { renderAuditReport } from "./reports/audit-report.js";
import { renderAdmissionReport } from "./reports/admission-report.js";

type DiscoveryArguments = {
  vault: string;
  output: string;
  admissionMode: AdmissionMode;
};

function parseCatalogArguments(argv: string[]): DiscoveryArguments {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        vault: { type: "string" },
        output: { type: "string" },
        apply: { type: "boolean", default: false },
        observe: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false }
      }
    });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid arguments: ${detail}\n\n${usage()}`, { cause: error });
  }

  if (
    parsed.positionals.length !== 2 ||
    parsed.positionals[0] !== "catalog" ||
    !["discover", "audit", "admit"].includes(parsed.positionals[1] ?? "")
  ) {
    throw new Error(usage());
  }

  if (!parsed.values.vault || !parsed.values.output) {
    throw new Error(`Both --vault and --output are required.\n\n${usage()}`);
  }

  if ((parsed.values.apply && parsed.values["dry-run"]) || (parsed.values.apply && parsed.values.observe) || (parsed.values.observe && parsed.values["dry-run"])) {
    throw new Error(`Use only one of --observe, --dry-run, or --apply.\n\n${usage()}`);
  }
  if (parsed.values.apply && parsed.positionals[1] !== "admit") {
    throw new Error(`--apply is supported only by catalog admit.\n\n${usage()}`);
  }
  const admissionMode: AdmissionMode = parsed.values.apply ? "APPLY" : parsed.values.observe ? "OBSERVE" : "PROPOSE";
  return { vault: parsed.values.vault, output: parsed.values.output, admissionMode };
}

function usage(): string {
  return [
    "Usage:",
    "  catalog discover --vault <path> --output <path>",
    "  catalog audit --vault <path> --output <path>",
    "  catalog admit --vault <path> --output <path> [--observe|--dry-run]",
    "  catalog admit --vault <path> --output <path> --apply",
    "",
    "Safety:",
    "  Reports are written outside the vault. Admit defaults to PROPOSE; only --apply selects APPLY mode and creates eligible missing project.md files."
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseCatalogArguments(argv);
  const vaultPath = await assertVaultDirectory(args.vault);
  const outputPath = await assertOutputOutsideVault(vaultPath, args.output);
  const discovery = await discoverCatalog(vaultPath);
  const command = argv[1];
  const report = command === "audit"
    ? renderAuditReport(await auditCatalog(discovery))
    : command === "admit"
      ? renderAdmissionReport(await admitProjects(vaultPath, args.admissionMode))
      : renderDiscoveryReport(discovery);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, report, "utf8");
  const label = command === "audit" ? "Audit" : command === "admit" ? "Admission" : "Discovery";
  process.stdout.write(`${label} report written to ${outputPath}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const modulePath = path.resolve(fileURLToPath(import.meta.url));
if (invokedPath === modulePath) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
