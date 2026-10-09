import { describe, expect, test } from "bun:test";
import {
  ADVISOR_NOTE_PREFIX,
  canPush,
  isAdvisorNote,
  isRepeat,
  newPushState,
  parseReview,
  pushNoteText,
  recordPush,
  resetPrompt,
  shouldPush,
  skipTurn,
  DEFAULT_PUSH,
} from "../src/push";

describe("parseReview", () => {
  test("reads a severity tag and strips it from the body", () => {
    expect(parseReview("[concern] The fix misses the retry path.")).toEqual({
      severity: "concern",
      body: "The fix misses the retry path.",
    });
    expect(parseReview("[BLOCKER] Stop: the migration drops a table.")).toEqual({
      severity: "blocker",
      body: "Stop: the migration drops a table.",
    });
  });

  test("treats untagged advice as a nit", () => {
    expect(parseReview("Consider a helper.")).toEqual({ severity: "nit", body: "Consider a helper." });
  });

  test("SILENT and empty replies are silent", () => {
    expect(parseReview("SILENT").severity).toBe("silent");
    expect(parseReview("  silent  ").severity).toBe("silent");
    expect(parseReview("   ").severity).toBe("silent");
  });
});

describe("shouldPush", () => {
  test("pushes at or above the minimum severity, never silent", () => {
    expect(shouldPush("blocker", "concern")).toBe(true);
    expect(shouldPush("concern", "concern")).toBe(true);
    expect(shouldPush("nit", "concern")).toBe(false);
    expect(shouldPush("nit", "nit")).toBe(true);
    expect(shouldPush("silent", "nit")).toBe(false);
  });
});

describe("push state", () => {
  test("a fresh state may push, and a push starts the cooldown", () => {
    const state = newPushState();
    expect(canPush(state, DEFAULT_PUSH)).toBe(true);
    recordPush(state, "Use a lock.", DEFAULT_PUSH);
    expect(canPush(state, DEFAULT_PUSH)).toBe(false);
  });

  test("cooldown counts down one agent-end at a time", () => {
    const state = newPushState();
    recordPush(state, "A.", { ...DEFAULT_PUSH, cooldownTurns: 2, maxPerPrompt: 9 });
    skipTurn(state);
    expect(canPush(state, { ...DEFAULT_PUSH, cooldownTurns: 2, maxPerPrompt: 9 })).toBe(false);
    skipTurn(state);
    expect(canPush(state, { ...DEFAULT_PUSH, cooldownTurns: 2, maxPerPrompt: 9 })).toBe(true);
  });

  test("maxPerPrompt caps pushes until the prompt resets", () => {
    const cfg = { ...DEFAULT_PUSH, cooldownTurns: 0, maxPerPrompt: 2 };
    const state = newPushState();
    recordPush(state, "A.", cfg);
    recordPush(state, "B.", cfg);
    expect(canPush(state, cfg)).toBe(false);
    resetPrompt(state);
    expect(canPush(state, cfg)).toBe(true);
  });

  test("detects a repeat of a recent note after normalizing", () => {
    const state = newPushState();
    recordPush(state, "Use a refresh lock!", { ...DEFAULT_PUSH, cooldownTurns: 0, maxPerPrompt: 9 });
    expect(isRepeat(state, "use a refresh lock")).toBe(true);
    expect(isRepeat(state, "Use a different lock")).toBe(false);
  });

  test("keeps readable text of recent notes for the reviewer", () => {
    const state = newPushState();
    recordPush(state, "Use a refresh lock.", { ...DEFAULT_PUSH, cooldownTurns: 0, maxPerPrompt: 9 });
    expect(state.raw).toEqual(["Use a refresh lock."]);
  });

  test("keeps only the last five notes", () => {
    const state = newPushState();
    const cfg = { ...DEFAULT_PUSH, cooldownTurns: 0, maxPerPrompt: 99 };
    for (let i = 0; i < 6; i++) recordPush(state, `note number ${i}`, cfg);
    expect(state.recent.length).toBe(5);
    expect(isRepeat(state, "note number 0")).toBe(false);
  });
});

describe("advisor note text", () => {
  test("builds a labelled note that is recognised on the way back", () => {
    const text = pushNoteText("concern", "Check the cache key.");
    expect(text).toBe(`${ADVISOR_NOTE_PREFIX} (concern): Check the cache key.`);
    expect(isAdvisorNote(text)).toBe(true);
    expect(isAdvisorNote("Please fix the cache key.")).toBe(false);
  });
});
