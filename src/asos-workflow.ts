import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { inspectCatalogAssets, type AssetInspectionFinding, type AssetInspectionReport } from "./asset-inspector.js";
import { renderManagedSongContractJson } from "./catalog/contract.js";
import { publishCatalogIndex, type CatalogIndex } from "./catalog/publish.js";
import { buildOperationJournal, type OperationJournal } from "./operation-journal.js";
import { assertOutputOutsideVault, assertVaultDirectory } from "./policy/source-of-truth.js";
import { buildReviewInbox, type ReviewInbox } from "./review-inbox.js";

export type FindingRoute = "evidence-only" | "reviewable" | "blocks-existing-proposal" | "eligible-for-proposal";

export type RoutedFindingSummary = {
  route: FindingRoute;
  count: number;
};

export type WorkflowArtifact = {
  name: "contract" | "catalog-index" | "asset-inspection" | "review-inbox" | "operation-journal";
  path: string;
  sha256: string;
  contract: string;
};

export type WorkflowStep = {
  name: WorkflowArtifact["name"] | "finding-router";
  authorityMode: string;
  status: "completed" | "blocked";
  inputArtifacts: string[];
  outputArtifacts: string[];
  notes: string[];
};

export type ReadOnlyRefreshWorkflowSummary = {
  contract: "asos-workflow-read-only-refresh.v1";
  workflow: "read-only-refresh";
  runId: string;
  generatedAt: string;
  authority: {
    system: "AIBRY Catalog OS";
    specialist: "ASOS Kernel / Workflow Orchestrator";
    authorityMode: "ORCHESTRATE";
    operationalStandard: "ASOS v1 / AVC v1";
    sourceOfTruth: "Music Vault";
    vaultMutation: "none";
  };
  source: {
    vaultPath: string;
    outputDirectory: string;
  };
  reviewStateMode: "fresh-unreviewed-snapshot";
  artifacts: WorkflowArtifact[];
  steps: WorkflowStep[];
  counts: {
    managedSongs: number;
    albumReleaseContainers: number;
    catalogFindings: number;
    assetProjects: number;
    assetRecords: number;
    assetFindings: number;
    reviewPending: number;
    reviewApproved: number;
    reviewDeferred: number;
    pendingApply: number;
    blockedInsufficientEvidence: number;
  };
  findingRoutes: RoutedFindingSummary[];
  safety: {
    applyEnabled: false;
    vaultMutation: "none";
    reviewInboxIntegration: "catalog-findings-only";
    assetFindingPolicy: "routed-for-kernel-context-not-direct-inbox";
  };
};

export async function runReadOnlyRefreshWorkflow(vaultInput: string, outputInput: string): Promise<ReadOnlyRefreshWorkflowSummary> {
  const vaultPath = await assertVaultDirectory(vaultInput);
  const outputPath = await assertOutputOutsideVault(vaultPath, outputInput);
  const outputDirectory = path.dirname(outputPath);
  const runId = runIdFromDate(new Date());
  const baseName = path.basename(outputPath, path.extname(outputPath));
  await mkdir(outputDirectory, { recursive: true });

  const contractPath = await workflowArtifactPath(vaultPath, outputDirectory, baseName, "contract");
  const catalogIndexPath = await workflowArtifactPath(vaultPath, outputDirectory, baseName, "catalog-index");
  const assetInspectionPath = await workflowArtifactPath(vaultPath, outputDirectory, baseName, "asset-inspection");
  const reviewInboxPath = await workflowArtifactPath(vaultPath, outputDirectory, baseName, "review-inbox");
  const operationJournalPath = await workflowArtifactPath(vaultPath, outputDirectory, baseName, "operation-journal");

  const contractJson = renderManagedSongContractJson();
  await writeFile(contractPath, contractJson, "utf8");

  const catalogIndex = await publishCatalogIndex(vaultPath);
  await writeJson(catalogIndexPath, catalogIndex);

  const assetInspection = await inspectCatalogAssets(vaultPath);
  await writeJson(assetInspectionPath, assetInspection);

  const reviewInbox = buildReviewInbox(catalogIndex);
  await writeJson(reviewInboxPath, reviewInbox);

  const operationJournal = buildOperationJournal(reviewInbox);
  await writeJson(operationJournalPath, operationJournal);

  const artifacts: WorkflowArtifact[] = [
    await artifact("contract", contractPath, "managed-song-contract.v1"),
    await artifact("catalog-index", catalogIndexPath, catalogIndex.schemaVersion),
    await artifact("asset-inspection", assetInspectionPath, assetInspection.contract),
    await artifact("review-inbox", reviewInboxPath, reviewInbox.schemaVersion),
    await artifact("operation-journal", operationJournalPath, operationJournal.schemaVersion)
  ];

  const findingRoutes = routeAssetFindings(assetInspection);
  const summary: ReadOnlyRefreshWorkflowSummary = {
    contract: "asos-workflow-read-only-refresh.v1",
    workflow: "read-only-refresh",
    runId,
    generatedAt: new Date().toISOString(),
    authority: workflowAuthority(),
    source: {
      vaultPath,
      outputDirectory
    },
    reviewStateMode: "fresh-unreviewed-snapshot",
    artifacts,
    steps: workflowSteps(artifacts, findingRoutes),
    counts: workflowCounts(catalogIndex, assetInspection, reviewInbox, operationJournal),
    findingRoutes,
    safety: {
      applyEnabled: false,
      vaultMutation: "none",
      reviewInboxIntegration: "catalog-findings-only",
      assetFindingPolicy: "routed-for-kernel-context-not-direct-inbox"
    }
  };
  await writeJson(outputPath, summary);
  return summary;
}

export function routeAssetInspectionFinding(finding: AssetInspectionFinding): FindingRoute {
  switch (finding.type) {
    case "media-info-audio-evidence":
    case "release-admin-empty":
      return "evidence-only";
    case "canonical-lyric-unresolved":
    case "provenance-insufficient":
      return "blocks-existing-proposal";
    case "multiple-audio-variants":
      return "reviewable";
    default:
      return "evidence-only";
  }
}

function workflowCounts(catalogIndex: CatalogIndex, assetInspection: AssetInspectionReport, reviewInbox: ReviewInbox, operationJournal: OperationJournal): ReadOnlyRefreshWorkflowSummary["counts"] {
  return {
    managedSongs: catalogIndex.counts.managedSongs,
    albumReleaseContainers: catalogIndex.counts.albumReleaseContainers,
    catalogFindings: catalogIndex.counts.findings,
    assetProjects: assetInspection.counts.projects,
    assetRecords: assetInspection.counts.assets,
    assetFindings: assetInspection.counts.findings,
    reviewPending: reviewInbox.counts.pending,
    reviewApproved: reviewInbox.counts.approved,
    reviewDeferred: reviewInbox.counts.deferred,
    pendingApply: operationJournal.counts.pendingApply,
    blockedInsufficientEvidence: operationJournal.counts.blockedInsufficientEvidence
  };
}

function routeAssetFindings(report: AssetInspectionReport): RoutedFindingSummary[] {
  const counts = new Map<FindingRoute, number>([
    ["evidence-only", 0],
    ["reviewable", 0],
    ["blocks-existing-proposal", 0],
    ["eligible-for-proposal", 0]
  ]);
  for (const inspection of report.inspections) {
    for (const finding of inspection.findings) {
      const route = routeAssetInspectionFinding(finding);
      counts.set(route, (counts.get(route) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([route, count]) => ({ route, count }));
}

function workflowSteps(artifacts: WorkflowArtifact[], routes: RoutedFindingSummary[]): WorkflowStep[] {
  const artifactPath = (name: WorkflowArtifact["name"]) => artifacts.find((artifactItem) => artifactItem.name === name)?.path ?? "";
  const routedCount = routes.reduce((total, route) => total + route.count, 0);
  return [
    {
      name: "contract",
      authorityMode: "OBSERVE_PROPOSE",
      status: "completed",
      inputArtifacts: [],
      outputArtifacts: [artifactPath("contract")],
      notes: ["Catalog Contract Steward emitted the active managed-song contract."]
    },
    {
      name: "catalog-index",
      authorityMode: "APPLY_OUTSIDE_VAULT",
      status: "completed",
      inputArtifacts: [artifactPath("contract")],
      outputArtifacts: [artifactPath("catalog-index")],
      notes: ["Catalog Publisher produced a disposable index outside the vault."]
    },
    {
      name: "asset-inspection",
      authorityMode: "OBSERVE",
      status: "completed",
      inputArtifacts: [artifactPath("catalog-index")],
      outputArtifacts: [artifactPath("asset-inspection")],
      notes: ["Asset Inspector inventoried asset folders without selecting canonical assets."]
    },
    {
      name: "finding-router",
      authorityMode: "ORCHESTRATE",
      status: "completed",
      inputArtifacts: [artifactPath("asset-inspection")],
      outputArtifacts: [],
      notes: [`Kernel routed ${routedCount} asset findings for context; asset findings are not direct Review Inbox proposals in v1.`]
    },
    {
      name: "review-inbox",
      authorityMode: "PROPOSE",
      status: "completed",
      inputArtifacts: [artifactPath("catalog-index")],
      outputArtifacts: [artifactPath("review-inbox")],
      notes: ["Review Inbox was generated from catalog findings only as a fresh unreviewed snapshot; Asset Inspector findings remain routed context."]
    },
    {
      name: "operation-journal",
      authorityMode: "HANDOFF",
      status: "completed",
      inputArtifacts: [artifactPath("review-inbox")],
      outputArtifacts: [artifactPath("operation-journal")],
      notes: ["Operation Journal evaluated reviewed proposals without APPLY capability in this workflow."]
    }
  ];
}

async function workflowArtifactPath(vaultPath: string, outputDirectory: string, baseName: string, artifactName: WorkflowArtifact["name"]): Promise<string> {
  return assertOutputOutsideVault(vaultPath, path.join(outputDirectory, `${baseName}.${artifactName}.json`));
}

async function artifact(name: WorkflowArtifact["name"], artifactPath: string, contract: string): Promise<WorkflowArtifact> {
  return { name, path: artifactPath, sha256: await hashFile(artifactPath), contract };
}

async function hashFile(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runIdFromDate(date: Date): string {
  return `read-only-refresh:${date.toISOString().replace(/[:.]/g, "-")}`;
}

function workflowAuthority(): ReadOnlyRefreshWorkflowSummary["authority"] {
  return {
    system: "AIBRY Catalog OS",
    specialist: "ASOS Kernel / Workflow Orchestrator",
    authorityMode: "ORCHESTRATE",
    operationalStandard: "ASOS v1 / AVC v1",
    sourceOfTruth: "Music Vault",
    vaultMutation: "none"
  };
}
