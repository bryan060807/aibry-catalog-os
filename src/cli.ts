#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runReadOnlyRefreshWorkflow } from "./asos-workflow.js";
import { inspectCatalogAssets } from "./asset-inspector.js";
import { discoverCatalog } from "./catalog/discover.js";
import { auditCatalog } from "./catalog/audit.js";
import { admitProjects } from "./catalog/admit.js";
import type { AdmissionMode } from "./catalog/admit.js";
import { renderManagedSongContractJson } from "./catalog/contract.js";
import { publishCatalogIndex } from "./catalog/publish.js";
import { buildValidationReportFromPaths } from "./independent-validator.js";
import { buildOperationJournalFromInboxPath } from "./operation-journal.js";
import { assertOutputOutsideVault, assertVaultDirectory } from "./policy/source-of-truth.js";
import { buildReviewInboxFromIndexPath } from "./review-inbox.js";
import { renderDiscoveryReport } from "./reports/discovery-report.js";
import { renderAuditReport } from "./reports/audit-report.js";
import { renderAdmissionReport } from "./reports/admission-report.js";

type CatalogCommand = "discover" | "audit" | "admit" | "publish" | "contract" | "inspect-assets" | "workflow" | "serve" | "review-inbox" | "operation-journal" | "validate-operations";
type WorkflowName = "read-only-refresh";

type CatalogArguments = {
  command: CatalogCommand;
  workflow: WorkflowName | null;
  vault: string | null;
  output: string | null;
  index: string | null;
  inbox: string | null;
  journal: string | null;
  results: string | null;
  decisions: string | null;
  host: string | null;
  port: number | null;
  admissionMode: AdmissionMode;
};

function parseCatalogArguments(argv: string[]): CatalogArguments {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        vault: { type: "string" },
        output: { type: "string" },
        index: { type: "string" },
        inbox: { type: "string" },
        journal: { type: "string" },
        results: { type: "string" },
        decisions: { type: "string" },
        host: { type: "string" },
        port: { type: "string" },
        apply: { type: "boolean", default: false },
        observe: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false }
      }
    });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid arguments: ${detail}\n\n${usage()}`, { cause: error });
  }

  const command = parsed.positionals[1] as CatalogCommand | undefined;
  if (parsed.positionals[0] !== "catalog" || !isCatalogCommand(command)) {
    throw new Error(usage());
  }

  if (command === "workflow") {
    const workflow = parsed.positionals[2] as WorkflowName | undefined;
    if (parsed.positionals.length !== 3 || workflow !== "read-only-refresh") {
      throw new Error(`Unknown or missing workflow.\n\n${usage()}`);
    }
    if (!parsed.values.vault || !parsed.values.output) {
      throw new Error(`--vault and --output are required for catalog workflow read-only-refresh.\n\n${usage()}`);
    }
    if (parsed.values.index || parsed.values.inbox || parsed.values.journal || parsed.values.results || parsed.values.decisions || parsed.values.host || parsed.values.port || parsed.values.apply || parsed.values.observe || parsed.values["dry-run"]) {
      throw new Error(`catalog workflow read-only-refresh accepts --vault and --output only.\n\n${usage()}`);
    }
    return {
      command,
      workflow,
      vault: parsed.values.vault,
      output: parsed.values.output,
      index: null,
      inbox: null,
      journal: null,
      results: null,
      decisions: null,
      host: null,
      port: null,
      admissionMode: "PROPOSE"
    };
  }

  if (parsed.positionals.length !== 2) {
    throw new Error(usage());
  }

  if (command === "serve" || command === "review-inbox" || command === "operation-journal" || command === "validate-operations") {
    if (command === "serve") {
      if (!parsed.values.index) {
        throw new Error(`--index is required for catalog serve.\n\n${usage()}`);
      }
      if (parsed.values.vault || parsed.values.output || parsed.values.inbox || parsed.values.journal || parsed.values.results || parsed.values.decisions || parsed.values.apply || parsed.values.observe || parsed.values["dry-run"]) {
        throw new Error(`catalog serve accepts --index, --host, and --port only.\n\n${usage()}`);
      }
      return {
        command,
        workflow: null,
        vault: null,
        output: null,
        index: parsed.values.index,
        inbox: null,
        journal: null,
        results: null,
        decisions: null,
        host: parsed.values.host ?? null,
        port: parseOptionalPort(parsed.values.port),
        admissionMode: "PROPOSE"
      };
    }
    if (command === "review-inbox") {
      if (!parsed.values.index || !parsed.values.output) {
        throw new Error(`--index and --output are required for catalog review-inbox.\n\n${usage()}`);
      }
      if (parsed.values.vault || parsed.values.inbox || parsed.values.journal || parsed.values.results || parsed.values.host || parsed.values.port || parsed.values.apply || parsed.values.observe || parsed.values["dry-run"]) {
        throw new Error(`catalog review-inbox accepts --index, --output, and optional --decisions only.\n\n${usage()}`);
      }
      return {
        command,
        workflow: null,
        vault: null,
        output: parsed.values.output,
        index: parsed.values.index,
        inbox: null,
        journal: null,
        results: null,
        decisions: parsed.values.decisions ?? null,
        host: null,
        port: null,
        admissionMode: "PROPOSE"
      };
    }
    if (command === "operation-journal") {
      if (!parsed.values.inbox || !parsed.values.output) {
        throw new Error(`--inbox and --output are required for catalog operation-journal.\n\n${usage()}`);
      }
      if (parsed.values.vault || parsed.values.index || parsed.values.journal || parsed.values.results || parsed.values.decisions || parsed.values.host || parsed.values.port || parsed.values.apply || parsed.values.observe || parsed.values["dry-run"]) {
        throw new Error(`catalog operation-journal accepts --inbox and --output only.\n\n${usage()}`);
      }
      return {
        command,
        workflow: null,
        vault: null,
        output: parsed.values.output,
        index: null,
        inbox: parsed.values.inbox,
        journal: null,
        results: null,
        decisions: null,
        host: null,
        port: null,
        admissionMode: "PROPOSE"
      };
    }
    if (!parsed.values.journal || !parsed.values.results || !parsed.values.output) {
      throw new Error(`--journal, --results, and --output are required for catalog validate-operations.\n\n${usage()}`);
    }
    if (parsed.values.vault || parsed.values.index || parsed.values.inbox || parsed.values.decisions || parsed.values.host || parsed.values.port || parsed.values.apply || parsed.values.observe || parsed.values["dry-run"]) {
      throw new Error(`catalog validate-operations accepts --journal, --results, and --output only.\n\n${usage()}`);
    }
    return {
      command,
      workflow: null,
      vault: null,
      output: parsed.values.output,
      index: null,
      inbox: null,
      journal: parsed.values.journal,
      results: parsed.values.results,
      decisions: null,
      host: null,
      port: null,
      admissionMode: "PROPOSE"
    };
  }

  if (!parsed.values.vault || !parsed.values.output) {
    throw new Error(`Both --vault and --output are required.\n\n${usage()}`);
  }
  if (parsed.values.index || parsed.values.inbox || parsed.values.journal || parsed.values.results || parsed.values.decisions || parsed.values.host || parsed.values.port) {
    throw new Error(`--index, --inbox, --journal, --results, --decisions, --host, and --port are supported only by catalog workflow, catalog serve, catalog review-inbox, catalog operation-journal, or catalog validate-operations.\n\n${usage()}`);
  }

  if ((parsed.values.apply && parsed.values["dry-run"]) || (parsed.values.apply && parsed.values.observe) || (parsed.values.observe && parsed.values["dry-run"])) {
    throw new Error(`Use only one of --observe, --dry-run, or --apply.\n\n${usage()}`);
  }
  if (parsed.values.apply && command !== "admit") {
    throw new Error(`--apply is supported only by catalog admit.\n\n${usage()}`);
  }
  if ((parsed.values.observe || parsed.values["dry-run"]) && command !== "admit") {
    throw new Error(`--observe and --dry-run are supported only by catalog admit.\n\n${usage()}`);
  }

  const admissionMode: AdmissionMode = parsed.values.apply ? "APPLY" : parsed.values.observe ? "OBSERVE" : "PROPOSE";
  return { command, workflow: null, vault: parsed.values.vault, output: parsed.values.output, index: null, inbox: null, journal: null, results: null, decisions: null, host: null, port: null, admissionMode };
}

function usage(): string {
  return [
    "Usage:",
    "  catalog discover --vault <path> --output <path>",
    "  catalog audit --vault <path> --output <path>",
    "  catalog admit --vault <path> --output <path> [--observe|--dry-run]",
    "  catalog admit --vault <path> --output <path> --apply",
    "  catalog contract --vault <path> --output <path>",
    "  catalog publish --vault <path> --output <path>",
    "  catalog inspect-assets --vault <path> --output <path>",
    "  catalog workflow read-only-refresh --vault <path> --output <path>",
    "  catalog serve --index <path> [--host 127.0.0.1] [--port 3873]",
    "  catalog review-inbox --index <path> --output <path> [--decisions <path>]",
    "  catalog operation-journal --inbox <path> --output <path>",
    "  catalog validate-operations --journal <path> --results <path> --output <path>",
    "",
    "Safety:",
    "  Reports, contracts, indexes, asset inspections, workflow summaries, review inboxes, operation journals, and validation reports are written outside the vault. Admit defaults to PROPOSE; only --apply selects APPLY mode and creates eligible missing project.md files. Publish writes a disposable catalog index and never mutates vault files. Asset Inspector observes asset folders and never chooses canonical assets or mutates vault files. Workflow read-only-refresh centralizes specialist execution under the ASOS Kernel with no APPLY capability. Serve exposes a read-only local API over a generated index. Review inbox converts findings into reviewable proposals without mutating vault files. Operation journal blocks non-executable approvals and never mutates vault files. Independent Validator observes operation results and never mutates vault files."
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseCatalogArguments(argv);

  if (args.command === "workflow") {
    const summary = await runReadOnlyRefreshWorkflow(args.vault ?? "", args.output ?? "");
    process.stdout.write(`Workflow ${summary.workflow} written to ${path.resolve(args.output ?? "")}\n`);
    return;
  }

  if (args.command === "serve") {
    const { startCatalogApi } = await import("./catalog-api.js");
    const api = await startCatalogApi({ indexPath: args.index ?? "", host: args.host ?? undefined, port: args.port ?? undefined });
    process.stdout.write(`Catalog API listening at ${api.url}\n`);
    return;
  }

  if (args.command === "review-inbox") {
    const inbox = await buildReviewInboxFromIndexPath(args.index ?? "", args.decisions ?? undefined);
    const outputPath = path.resolve(args.output ?? "");
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(inbox, null, 2)}\n`, "utf8");
    process.stdout.write(`Review inbox written to ${outputPath}\n`);
    return;
  }

  if (args.command === "operation-journal") {
    const journal = await buildOperationJournalFromInboxPath(args.inbox ?? "");
    const outputPath = path.resolve(args.output ?? "");
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
    process.stdout.write(`Operation journal written to ${outputPath}\n`);
    return;
  }

  if (args.command === "validate-operations") {
    const report = await buildValidationReportFromPaths(args.journal ?? "", args.results ?? "");
    const outputPath = path.resolve(args.output ?? "");
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`Validation report written to ${outputPath}\n`);
    return;
  }

  const vaultPath = await assertVaultDirectory(args.vault ?? "");
  const outputPath = await assertOutputOutsideVault(vaultPath, args.output ?? "");
  const discovery = args.command === "publish" || args.command === "contract" || args.command === "inspect-assets" ? null : await discoverCatalog(vaultPath);
  const report = args.command === "audit"
    ? renderAuditReport(await auditCatalog(discovery ?? await discoverCatalog(vaultPath)))
    : args.command === "admit"
      ? renderAdmissionReport(await admitProjects(vaultPath, args.admissionMode))
      : args.command === "publish"
        ? `${JSON.stringify(await publishCatalogIndex(vaultPath), null, 2)}\n`
        : args.command === "contract"
          ? renderManagedSongContractJson()
          : args.command === "inspect-assets"
            ? `${JSON.stringify(await inspectCatalogAssets(vaultPath), null, 2)}\n`
            : renderDiscoveryReport(discovery ?? await discoverCatalog(vaultPath));

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, report, "utf8");
  const label = args.command === "audit" ? "Audit" : args.command === "admit" ? "Admission" : args.command === "publish" ? "Catalog index" : args.command === "contract" ? "Catalog contract" : args.command === "inspect-assets" ? "Asset inspection" : "Discovery";
  process.stdout.write(`${label} written to ${outputPath}\n`);
}

function parseOptionalPort(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`--port must be an integer from 1 to 65535.\n\n${usage()}`);
  }
  return port;
}

function isCatalogCommand(value: string | undefined): value is CatalogCommand {
  return value === "discover" || value === "audit" || value === "admit" || value === "publish" || value === "contract" || value === "inspect-assets" || value === "workflow" || value === "serve" || value === "review-inbox" || value === "operation-journal" || value === "validate-operations";
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
