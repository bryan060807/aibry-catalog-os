# Archivist Report Format

Every Archivist report contains:

1. Audit metadata: vault root, timestamp, read-only mode, and scope limits.
2. Severity summary: `error`, `warning`, and `info` counts.
3. One finding per issue with:
   - stable finding ID;
   - severity and category;
   - source path;
   - evidence (observed facts only);
   - non-mutating recommendation.
4. Mutation safeguard stating that no action was applied automatically.

Severity guide:

- `error`: malformed structured metadata that prevents reliable interpretation.
- `warning`: a review-required integrity concern, such as an unsafe front door, duplicate declared ID/title, empty release container, or broken declared relationship.
- `info`: an observed state or evidence gap, such as absent structured provenance or remaining legacy inventory.

Recommendations must propose review, confirmation, or a separately approved plan. They must not prescribe automatic move, rename, deletion, or rewrite actions.
