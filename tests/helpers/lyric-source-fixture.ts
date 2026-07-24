import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Bytes } from "../../src/kernel/canonical-json.js";
import type { LyricControlFileInput, LyricFileState, LyricSourcePlanningInput, LyricSourcePlanningProject } from "../../src/lyric-source/contracts.js";

type GoldenDefinition = {
  contract: "golden-lyric-source-migration-fixture.v1";
  batchId: string;
  name: string;
  albumSlug: string;
  generatedAt: string;
  tracks: Array<{ slug: string; include: boolean; exclusionReason?: string }>;
  baseline: { catalogFindings: number; assetFindings: number; blocksExistingProposal: number };
  expected: { catalogFindings: number; assetFindings: number; blocksExistingProposal: number };
};

export type MaterializedLyricFixture = {
  vault: string;
  input: LyricSourcePlanningInput;
  inputPath: string;
};

export async function materializeGoldenLyricFixture(name: "black-box-psalms" | "the-violence-of-spring", root: string): Promise<MaterializedLyricFixture> {
  const definitionPath = fileURLToPath(new URL(`../../../fixtures/lyric-source/${name}.json`, import.meta.url));
  const definition = JSON.parse(await readFile(definitionPath, "utf8")) as GoldenDefinition;
  const vault = path.join(root, "fixture-vault");
  await mkdir(vault, { recursive: true });
  const projectRoot = `project-memory/music/albums/${definition.albumSlug}`;
  const projects: LyricSourcePlanningProject[] = [];
  for (const track of definition.tracks) {
    const projectPath = `${projectRoot}/${track.slug}`;
    if (!track.include) {
      projects.push({ projectPath, include: false, exclusionReason: track.exclusionReason ?? "Excluded pending fresh evidence.", source: null, managed: null, candidates: [], controlFile: null });
      continue;
    }
    const lyric = `# ${track.slug}\n\nGolden fixture lyric evidence for ${definition.name}.\n`;
    const sourcePath = `lyrics/albums/${definition.albumSlug}/${track.slug}.md`;
    const managedPath = `${projectPath}/lyrics/${track.slug}.md`;
    const source = fileState(sourcePath, lyric);
    const managed = fileState(managedPath, lyric);
    await writeVaultFile(vault, sourcePath, lyric);
    await writeVaultFile(vault, managedPath, lyric);
    const current = `# ${track.slug}\n\nLegacy project control file.\n`;
    const proposed = `---\nprovenance:\n  contract: lyric-source-designation.v1\n  status: verified\nsource_path: ${sourcePath}\nmanaged_lyric_copy: ${managedPath}\nsource_sha256: ${source.sha256}\nmanaged_sha256: ${managed.sha256}\nverification_method: sha256-byte-match\nverification_state: verified\ndesignation_state: human-approved\n---\n# ${track.slug}\n\nDesignation prospective until exact proposal approval and guarded APPLY.\n`;
    const controlFile = controlFileInput(`${projectPath}/project.md`, current, proposed);
    await writeVaultFile(vault, controlFile.path, current);
    projects.push({
      projectPath,
      include: true,
      exclusionReason: null,
      source,
      managed,
      candidates: [{ ...managed, accepted: true, exactNameMatch: true }],
      controlFile
    });
  }
  const included = projects.filter((project) => project.include);
  const manifestMappings = included.map((project) => {
    const source = project.source as LyricFileState;
    const managed = project.managed as LyricFileState;
    return `  - project_path: ${project.projectPath}\n    source_path: ${source.path}\n    managed_lyric_copy: ${managed.path}\n    source_sha256: ${source.sha256}\n    managed_sha256: ${managed.sha256}\n    designation_state: human-approved`;
  }).join("\n");
  const albumControlFiles = [
    controlFileInput(`${projectRoot}/migration-manifest.md`, `---\ncontract: lyric-source-migration-manifest.v1\nentries: []\n---\n`, `---\ncontract: lyric-source-migration-manifest.v1\nentries:\n${manifestMappings}\n---\n# ${definition.name} Migration Manifest\n`),
    controlFileInput(`${projectRoot}/README.md`, `# ${definition.name}\n\nCatalog workspace.\n`, `# ${definition.name}\n\nHuman-approved lyric-source designations are recorded in migration-manifest.md after exact approval and guarded APPLY.\n`),
    controlFileInput(`${projectRoot}/tracklist.md`, `# ${definition.name} Tracklist\n`, `# ${definition.name} Tracklist\n\n${included.map((project) => `- ${project.projectPath}: designated lyric source`).join("\n")}\n`)
  ];
  for (const control of albumControlFiles) {
    await writeVaultFile(vault, control.path, Buffer.from(control.currentContentBase64, "base64").toString("utf8"));
  }
  const guardFiles = [
    fileState(`${projectRoot}/album-release-package.md`, "# Release package\n\nFixture guard one.\n"),
    fileState(`${projectRoot}/project.md`, `# ${definition.name}\n\nFixture guard two.\n`)
  ];
  for (const guard of guardFiles) {
    await writeVaultFile(vault, guard.path, Buffer.from(guard.contentBase64, "base64").toString("utf8"));
  }
  const input: LyricSourcePlanningInput = {
    contract: "lyric-source-planning-input.v1",
    generatedAt: definition.generatedAt,
    selectedBatch: { batchId: definition.batchId, name: definition.name, projectPaths: projects.map((project) => project.projectPath) },
    projects,
    albumControlFiles,
    currentCatalogIndex: { contract: "catalog-index.v1", sha256: "1".repeat(64), counts: { findings: definition.baseline.catalogFindings } },
    assetInspectorEvidence: { contract: "asset-inspection.v1", sha256: "2".repeat(64), counts: { findings: definition.baseline.assetFindings } },
    lyricSourceResolverEvidence: { contract: "lyric-source-resolution.v1", sha256: "3".repeat(64), projectPaths: included.map((project) => project.projectPath) },
    baselineCounts: { catalogFindings: definition.baseline.catalogFindings, assetFindings: definition.baseline.assetFindings, routedFindings: { "blocks-existing-proposal": definition.baseline.blocksExistingProposal } },
    expectedCounts: { catalogFindings: definition.expected.catalogFindings, assetFindings: definition.expected.assetFindings, routedFindings: { "blocks-existing-proposal": definition.expected.blocksExistingProposal } },
    guardFiles,
    preconditions: ["Current control-file hashes must match.", "Lyric evidence hashes and sizes must remain unchanged."],
    rollbackRequirements: ["Copy and rehash every original outside the Music Vault before authorization.", "Restore every target and verify original hashes after any post-write failure."],
    independentValidatorCriteria: ["All proposed hashes are live.", "Resolver records exist exactly once.", "No unrelated file changed."]
  };
  const inputPath = path.join(root, `${name}.planning-input.json`);
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`, "utf8");
  return { vault, input, inputPath };
}

function fileState(filePath: string, content: string): LyricFileState {
  const bytes = Buffer.from(content, "utf8");
  return { path: filePath, byteSize: bytes.byteLength, sha256: sha256Bytes(bytes), contentBase64: bytes.toString("base64") };
}

function controlFileInput(filePath: string, current: string, proposed: string): LyricControlFileInput {
  const bytes = Buffer.from(current, "utf8");
  return { path: filePath, currentByteSize: bytes.byteLength, currentSha256: sha256Bytes(bytes), currentContentBase64: bytes.toString("base64"), proposedContent: proposed };
}

async function writeVaultFile(root: string, contractPath: string, content: string): Promise<void> {
  const filePath = path.join(root, ...contractPath.split("/"));
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}
