import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const NOTES_MAX_CHARS = 8_000;
const NOTES_FILE = join(".opencode", "advisor.md");

/** Project priorities for the reviewer, read only when the user opts in with /advisor notes on. */
export async function readProjectNotes(directory: string): Promise<string | undefined> {
  try {
    return (await readFile(join(directory, NOTES_FILE), "utf8")).slice(0, NOTES_MAX_CHARS);
  } catch {
    return undefined;
  }
}
