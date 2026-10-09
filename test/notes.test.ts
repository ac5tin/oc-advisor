import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NOTES_MAX_CHARS, readProjectNotes } from "../src/notes";

function projectWith(notes?: string): string {
  const dir = mkdtempSync("/tmp/opencode/notes-");
  if (notes !== undefined) {
    mkdirSync(join(dir, ".opencode"));
    writeFileSync(join(dir, ".opencode", "advisor.md"), notes);
  }
  return dir;
}

describe("readProjectNotes", () => {
  test("returns the project's .opencode/advisor.md", async () => {
    expect(await readProjectNotes(projectWith("Prefer small diffs."))).toBe("Prefer small diffs.");
  });

  test("returns undefined when the file is missing", async () => {
    expect(await readProjectNotes(projectWith())).toBeUndefined();
  });

  test("caps very long notes", async () => {
    const notes = await readProjectNotes(projectWith("x".repeat(NOTES_MAX_CHARS + 500)));
    expect(notes?.length).toBe(NOTES_MAX_CHARS);
  });
});
