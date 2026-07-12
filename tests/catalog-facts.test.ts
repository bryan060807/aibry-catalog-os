import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

type CatalogFacts = {
  managed_songs: Array<{ title: string; release_context: "standalone-single" | "album-track" }>;
  managed_album_track_songs: string[];
  legacy_corpus: Record<string, string[]>;
};

test("approved catalog facts fixture parses and preserves regression facts", async () => {
  const fixturePath = path.resolve("fixtures", "catalog-facts.yaml");
  const facts = parse(await readFile(fixturePath, "utf8")) as CatalogFacts;

  assert.deepEqual(facts.managed_songs, [
    { title: "The Kid in the Machine", release_context: "standalone-single" },
    { title: "Pressure Flower", release_context: "standalone-single" },
    { title: "Came Out Wrong", release_context: "standalone-single" }
  ]);
  assert.deepEqual(facts.managed_album_track_songs, [
    "01-rust-on-the-ignition",
    "02-oxidation-at-the-joints",
    "03-voltage-bleed",
    "04-scrap-iron-sermon",
    "05-hemlock-and-concrete",
    "06-tectonic-deficit",
    "07-seismic-debt",
    "08-ground-wire-autopsy",
    "09-wiretap-eviction"
  ]);
  assert.equal(facts.managed_songs.some((song) => song.title === "Cobalt Infrastructure"), false);
  assert.deepEqual(facts.legacy_corpus["The Violence of Spring"], ["Cobalt Infrastructure"]);
});
