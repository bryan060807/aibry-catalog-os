import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { runReadOnlyRefreshWorkflow } from "../../src/asos-workflow.js";

export type LyricSourceScoutFixture = {
  vault: string;
  refreshReportPath: string;
  reportsRoot: string;
  driftManagedPath: string | null;
};

type TrackMode = "safe" | "mismatch" | "name-mismatch" | "ambiguous" | "missing-source" | "manifest-conflict" | "designated" | "linked";

export async function materializeLyricSourceScoutFixture(root: string, mode: "full" | "refusal" = "full"): Promise<LyricSourceScoutFixture> {
  const vault = path.join(root, "fixture-vault");
  const reportsRoot = path.join(root, "reports");
  const refreshReportPath = path.join(reportsRoot, "refresh", "read-only-refresh.json");
  await mkdir(path.join(vault, "instructions"), { recursive: true });
  await mkdir(reportsRoot, { recursive: true });
  await writeFile(path.join(vault, "instructions", "catalog-structure.md"), "# Scout fixture structure\n", "utf8");

  if (mode === "refusal") {
    await createRelease(vault, "one-track-only", [{ slug: "01-alone", mode: "safe" }]);
  } else {
    await createRelease(vault, "alpha-signal", [
      { slug: "01-first-light", mode: "safe" },
      { slug: "02-second-light", mode: "safe" },
      { slug: "03-third-light", mode: "safe" },
      { slug: "04-fourth-light", mode: "safe" },
      { slug: "05-boundary", mode: "mismatch" }
    ]);
    await createRelease(vault, "beta-signal", [
      { slug: "01-first-wave", mode: "safe" },
      { slug: "02-second-wave", mode: "safe" },
      { slug: "03-third-wave", mode: "safe" },
      { slug: "04-fourth-wave", mode: "safe" },
      { slug: "05-boundary", mode: "mismatch" }
    ]);
    await createRelease(vault, "one-safe-track", [
      { slug: "01-safe", mode: "safe" },
      { slug: "02-unsafe", mode: "mismatch" }
    ]);
    await createRelease(vault, "ambiguous-release", [{ slug: "01-ambiguous", mode: "ambiguous" }]);
    await createRelease(vault, "missing-source-release", [{ slug: "01-missing-source", mode: "missing-source" }]);
    await createRelease(vault, "hash-mismatch-release", [{ slug: "01-hash-mismatch", mode: "mismatch" }]);
    await createRelease(vault, "name-mismatch-release", [{ slug: "01-name-mismatch", mode: "name-mismatch" }]);
    await createRelease(vault, "manifest-conflict-release", [{ slug: "01-manifest-conflict", mode: "manifest-conflict" }]);
    await createRelease(vault, "designated-release", [{ slug: "01-designated", mode: "designated" }]);
    await createRelease(vault, "linked-release", [{ slug: "01-linked", mode: "linked" }]);
    await createRelease(vault, "black-box-psalms", [
      { slug: "01-golden-one", mode: "safe" }, { slug: "02-golden-two", mode: "safe" }
    ]);
    await createRelease(vault, "the-violence-of-spring", [
      { slug: "01-golden-one", mode: "safe" }, { slug: "02-golden-two", mode: "safe" }
    ]);
  }
  await runReadOnlyRefreshWorkflow(vault, refreshReportPath);
  return {
    vault,
    reportsRoot,
    refreshReportPath,
    driftManagedPath: mode === "full"
      ? path.join(vault, "project-memory", "music", "albums", "alpha-signal", "01-first-light", "lyrics", "01-first-light.md")
      : null
  };
}

export async function materializeGroundWireGospelFixture(root: string): Promise<LyricSourceScoutFixture> {
  const vault = path.join(root, "fixture-vault");
  const reportsRoot = path.join(root, "reports");
  const refreshReportPath = path.join(reportsRoot, "refresh", "read-only-refresh.json");
  await mkdir(path.join(vault, "instructions"), { recursive: true });
  await mkdir(reportsRoot, { recursive: true });
  await writeFile(path.join(vault, "instructions", "catalog-structure.md"), "# Ground Wire Gospel fixture structure\n", "utf8");
  await createGroundWireGospelRelease(vault);
  await runReadOnlyRefreshWorkflow(vault, refreshReportPath);
  return { vault, reportsRoot, refreshReportPath, driftManagedPath: null };
}

async function createRelease(vault: string, albumSlug: string, tracks: Array<{ slug: string; mode: TrackMode }>): Promise<void> {
  const release = path.join(vault, "project-memory", "music", "albums", albumSlug);
  const legacyRelease = path.join(vault, "lyrics", "albums", albumSlug);
  await mkdir(release, { recursive: true });
  await mkdir(path.dirname(legacyRelease), { recursive: true });
  const manifestEntries = tracks.filter((track) => track.mode === "manifest-conflict").map((track) => [
    `  - project_path: project-memory/music/albums/${albumSlug}/${track.slug}`,
    `    source_path: lyrics/albums/${albumSlug}/wrong-source.md`,
    `    managed_lyric_copy: project-memory/music/albums/${albumSlug}/${track.slug}/lyrics/${track.slug}.md`
  ].join("\n"));
  await writeFile(path.join(release, "migration-manifest.md"), [
    "---", "contract: lyric-source-migration-manifest.v1", manifestEntries.length ? "entries:" : "entries: []", ...manifestEntries, "---", "# Current Migration Manifest", ""
  ].join("\n"), "utf8");
  await writeFile(path.join(release, "README.md"), `# ${albumSlug}\n\nCurrent album workspace.\n`, "utf8");
  await writeFile(path.join(release, "tracklist.md"), `# ${albumSlug} Tracklist\n\n${tracks.map((track) => `- ${track.slug}: unresolved`).join("\n")}\n`, "utf8");
  await writeFile(path.join(release, "project.md"), `# ${albumSlug} Album Project\n\nGuard file.\n`, "utf8");
  await writeFile(path.join(release, "album-release-package.md"), `# ${albumSlug} Release Package\n\nGuard file.\n`, "utf8");

  if (tracks.some((track) => track.mode === "linked")) {
    const target = path.join(vault, "linked-evidence", albumSlug);
    await mkdir(target, { recursive: true });
    for (const track of tracks.filter((candidate) => candidate.mode === "linked")) {
      await writeFile(path.join(target, `${track.slug}.md`), lyricBytes(albumSlug, track.slug), "utf8");
    }
    await symlink(target, legacyRelease, process.platform === "win32" ? "junction" : "dir");
  } else {
    await mkdir(legacyRelease, { recursive: true });
  }

  for (const track of tracks) {
    const project = path.join(release, track.slug);
    const managedDirectory = path.join(project, "lyrics");
    await mkdir(managedDirectory, { recursive: true });
    const lyric = lyricBytes(albumSlug, track.slug);
    const projectControl = track.mode === "designated"
      ? `---\nprovenance:\n  contract: lyric-source-designation.v1\ndesignation_state: human-approved\n---\n# ${track.slug}\n\n## Lyric Source\nLyric source unresolved.\n\n## Production Status\nMix approval remains unresolved.\n`
      : `# ${track.slug}\n\n## Lyric Source\nLyric source unresolved.\nVerify the canonical lyric source.\nPromote this draft to the track root as project.md.\n\n## Production Status\nMix approval remains unresolved.\n\n## Release Readiness\nArtwork and licensing remain unresolved.\n`;
    await writeFile(path.join(project, "project.md"), projectControl, "utf8");
    const managedName = track.mode === "name-mismatch" ? `${track.slug.toUpperCase()}.md` : `${track.slug}.md`;
    await writeFile(path.join(managedDirectory, managedName), track.mode === "mismatch" ? `${lyric}managed mismatch\n` : lyric, "utf8");
    if (track.mode === "ambiguous") {
      await writeFile(path.join(managedDirectory, "alternate-candidate.md"), lyric, "utf8");
    }
    if (track.mode !== "missing-source" && track.mode !== "linked") {
      await writeFile(path.join(legacyRelease, `${track.slug}.md`), lyric, "utf8");
    }
  }
}

async function createGroundWireGospelRelease(vault: string): Promise<void> {
  const albumSlug = "ground-wire-gospel";
  const release = path.join(vault, "project-memory", "music", "albums", albumSlug);
  const legacyRelease = path.join(vault, "lyrics", "albums", albumSlug);
  const tracks = [
    ["01-rust-on-the-ignition", "Rust on the Ignition"],
    ["02-oxidation-at-the-joints", "Oxidation at the Joints"],
    ["03-voltage-bleed", "Voltage Bleed"],
    ["04-scrap-iron-sermon", "Scrap Iron Sermon"],
    ["05-broken-testimony", "Broken Testimony"],
    ["06-iron-prayer", "Iron Prayer"],
    ["07-fatal-design", "Fatal Design"],
    ["08-last-broadcast", "Last Broadcast"],
    ["09-after-the-fire", "After the Fire"]
  ] as const;
  await mkdir(release, { recursive: true });
  await mkdir(legacyRelease, { recursive: true });
  await writeFile(path.join(release, "migration-manifest.md"), [
    "# Ground Wire Gospel Migration Record",
    "",
    "Migration date: 2025-11-07",
    "Migration method: non-destructive project-folder normalization",
    "",
    "## Completed",
    "",
    "- Created the album release container.",
    "- Preserved every legacy lyric source.",
    "",
    "## Structural Mapping",
    "",
    "| Existing folder | Catalog OS meaning | Migration handling |",
    "| --- | --- | --- |",
    "| album notes | album release-container history | Keep unchanged |",
    "| `lyrics/` | release-package lyric copies | Keep; canonical lyric source remains in `/lyrics/` root |",
    "",
    "## Not Changed",
    "",
    "- Audio masters, artwork, credits, and release metadata were not changed.",
    "",
    "## Remaining Migration Work",
    "",
    "- Resolve lyric provenance track by track.",
    "- Complete mastering and release-readiness review.",
    ""
  ].join("\n"), "utf8");
  await writeFile(path.join(release, "README.md"), [
    "# Ground Wire Gospel",
    "",
    "## Read Order",
    "",
    "1. Read this album front door.",
    "2. Read the tracklist and project controls.",
    "",
    "## Purpose",
    "",
    "Coordinate the album without replacing creative source material.",
    "",
    "## Canonical Sources",
    "",
    "- Legacy lyrics remain preserved as evidence.",
    "- Track project files govern production decisions.",
    "",
    "## Album Folder Contract",
    "",
    "Each numbered folder contains one track project and its managed assets.",
    "",
    "## Known Album State",
    "",
    "Mastering, quality control, metadata, credits, artwork, and licensing remain under review.",
    "",
    "## Non-Destructive Migration Rule",
    "",
    "Preserve the legacy record and add bounded verification metadata only.",
    ""
  ].join("\n"), "utf8");
  await writeFile(path.join(release, "tracklist.md"), [
    "# Ground Wire Gospel Tracklist",
    "",
    "| Track | Title | Folder | Canonical Source |",
    "| ---: | --- | --- | --- |",
    ...tracks.map(([slug, title]) => `| ${Number(slug.slice(0, 2))} | ${title} | \`${slug}/\` | unresolved |`),
    "",
    "## Track 07 Rename Rule",
    "",
    "Track 07 retains the Fatal Design rename rule; do not restore an earlier working title.",
    "",
    "## Supplementary Album Notes",
    "",
    "The running order remains provisional until mastering and sequencing review completes.",
    ""
  ].join("\n"), "utf8");
  await writeFile(path.join(release, "project.md"), "# Ground Wire Gospel Album Project\n\nGuard file: album-level decisions remain unchanged.\n", "utf8");
  await writeFile(path.join(release, "album-release-package.md"), "# Ground Wire Gospel Release Package\n\nGuard file: release-package state remains unchanged.\n", "utf8");

  for (const [slug, title] of tracks) {
    const project = path.join(release, slug);
    const managedDirectory = path.join(project, "lyrics");
    await mkdir(managedDirectory, { recursive: true });
    const lyric = lyricBytes(albumSlug, slug);
    await writeFile(path.join(legacyRelease, `${slug}.md`), lyric, "utf8");
    await writeFile(
      path.join(managedDirectory, `${slug}.md`),
      slug.startsWith("09-") ? `${lyric}Managed copy differs for the fixture boundary.\n` : lyric,
      "utf8"
    );
    await writeFile(path.join(project, "project.md"), [
      `# ${title}`,
      "",
      "## Canonical References",
      "",
      `- Legacy lyric evidence: \`lyrics/albums/${albumSlug}/${slug}.md\``,
      `- Album migration record: \`project-memory/music/albums/${albumSlug}/migration-manifest.md\``,
      "",
      "## Existing Assets",
      "",
      "- Managed lyric copy is present.",
      "- Mix and artwork references are present.",
      "",
      "## Required Decisions",
      "",
      "- [ ] Verify lyric copy against canonical source.",
      "- [ ] Approve final mastering.",
      "- [ ] Complete QC review.",
      "- [ ] Confirm metadata and credits.",
      "- [ ] Approve artwork, licensing, and release sequence.",
      "",
      "## Release Notes",
      "",
      "Preserve the current title, credits, and production history.",
      ""
    ].join("\n"), "utf8");
  }
}

function lyricBytes(albumSlug: string, trackSlug: string): string {
  return `# ${trackSlug}\n\nDeterministic lyric evidence for ${albumSlug}.\n`;
}
