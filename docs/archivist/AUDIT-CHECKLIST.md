# Archivist Audit Checklist

Use this as a read-only checklist. Every issue must retain exact paths and evidence; no checklist outcome authorizes a change.

- Duplicate IDs and titles: compare admitted `project.md` titles; compare IDs only when YAML front matter declares an `id`; classify intentional duplicate status as unknown until reviewed.
- Missing front doors: identify song-shaped candidates with missing or unsafe direct `project.md`; do not create front doors.
- Malformed metadata/front matter: detect unmatched YAML delimiters, invalid YAML, or a non-mapping front-matter document in `project.md` and direct `metadata/*.md|yaml|yml` files.
- Orphaned tracks/albums: identify album release containers with no admitted tracks; report without deciding whether a directory is obsolete.
- Broken relationships: inspect only declared YAML fields `related_to`, `relationship`, `source_project`, and `parent_project`; flag targets that do not match an admitted project path.
- Migration completeness: compare observed managed front doors and legacy inventory; identify inventory remaining and do not infer destinations or bulk-migration status.
- Provenance: check for declared front-matter fields `provenance`, `source_path`, `source_paths`, or `legacy_source`; absence is an informational evidence gap, not an error.
- Safety confirmation: confirm the report output is outside the vault and record that no vault mutation occurred.

Not currently assessed: undocumented relationships, metadata formats outside the files above, rights, canon, release approval, semantic lyric duplication, and migration intent. Report these as unknown when they matter.
