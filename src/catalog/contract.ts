export type CatalogLifecycleState = "draft" | "active" | "ready-for-release" | "released" | "archived" | "needs-review";

export type ContractFieldRequirement = {
  name: string;
  requirement: "required" | "recommended" | "optional";
  valueType: "string" | "string[]" | "date" | "enum" | "object";
  allowedValues?: string[];
  evidenceRule: string;
};

export type ManagedSongContract = {
  schemaVersion: "managed-song-contract.v1";
  steward: {
    specialist: "Catalog Contract Steward";
    authorityMode: "OBSERVE_PROPOSE";
    operationalStandard: "ASOS v1";
    sourceOfTruth: "Music Vault";
    vaultMutation: "none";
  };
  subject: "managed-song";
  canonicalFrontDoor: "project.md";
  lifecycleStates: CatalogLifecycleState[];
  requiredFrontMatter: ContractFieldRequirement[];
  recommendedFrontMatter: ContractFieldRequirement[];
  compatibilityRules: string[];
  safetyRules: string[];
};

export const MANAGED_SONG_CONTRACT_V1: ManagedSongContract = {
  schemaVersion: "managed-song-contract.v1",
  steward: {
    specialist: "Catalog Contract Steward",
    authorityMode: "OBSERVE_PROPOSE",
    operationalStandard: "ASOS v1",
    sourceOfTruth: "Music Vault",
    vaultMutation: "none"
  },
  subject: "managed-song",
  canonicalFrontDoor: "project.md",
  lifecycleStates: ["draft", "active", "ready-for-release", "released", "archived", "needs-review"],
  requiredFrontMatter: [
    {
      name: "id",
      requirement: "required",
      valueType: "string",
      evidenceRule: "Must be explicitly declared in YAML front matter; Catalog OS must not infer or rewrite IDs automatically."
    },
    {
      name: "title",
      requirement: "required",
      valueType: "string",
      evidenceRule: "Must match the reviewed song title or be proposed by Metadata Curator with evidence."
    },
    {
      name: "lifecycle_state",
      requirement: "required",
      valueType: "enum",
      allowedValues: ["draft", "active", "ready-for-release", "released", "archived", "needs-review"],
      evidenceRule: "Must be one of the managed-song lifecycle states and reflect a reviewed operational decision."
    }
  ],
  recommendedFrontMatter: [
    {
      name: "release_context",
      requirement: "recommended",
      valueType: "object",
      evidenceRule: "Should describe whether the song is a standalone single or an album track using observed vault placement."
    },
    {
      name: "provenance",
      requirement: "recommended",
      valueType: "object",
      evidenceRule: "Should list verified source paths, migration history, and confidence; never fabricate missing provenance."
    },
    {
      name: "credits",
      requirement: "recommended",
      valueType: "object",
      evidenceRule: "Should include only verified contributors, roles, tools, or generation provenance."
    },
    {
      name: "tags",
      requirement: "recommended",
      valueType: "string[]",
      evidenceRule: "Should be normalized by Metadata Curator from verified project context or approved human input."
    }
  ],
  compatibilityRules: [
    "A managed song is a song-shaped directory with a direct regular project.md front door.",
    "Album release containers group tracks; they are not managed-song records unless they contain their own authorized front door in a future contract.",
    "Generated catalog indexes are disposable and must be rebuildable from Music Vault material plus operational records.",
    "Specialists may propose metadata improvements, but only guarded APPLY paths may mutate canonical vault files."
  ],
  safetyRules: [
    "The contract steward never mutates the Music Vault.",
    "Missing required fields are findings or proposals, not automatic edits.",
    "Human approval is required before a mutating specialist applies contract repairs.",
    "Independent Validator must reinspect any applied contract repair before Catalog OS marks it verified."
  ]
};

export function getManagedSongContract(): ManagedSongContract {
  return MANAGED_SONG_CONTRACT_V1;
}

export function renderManagedSongContractJson(): string {
  return `${JSON.stringify(getManagedSongContract(), null, 2)}\n`;
}
