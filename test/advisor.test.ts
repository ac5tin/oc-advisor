import { describe, expect, test } from "bun:test";
import {
  ADVISOR_SYSTEM_PROMPT,
  buildAdvisorPrompt,
  EXECUTOR_GUIDANCE,
  isDisabledModel,
  maxUsesExceeded,
  parseAdvisorArgs,
  parseModelRef,
} from "../src/advisor";

describe("parseModelRef", () => {
  test("splits provider, model with slashes, and variant", () => {
    expect(parseModelRef("anthropic/claude-opus-4-6#high")).toEqual({
      providerID: "anthropic",
      id: "claude-opus-4-6",
      variant: "high",
    });
  });

  test("keeps slashes inside the model id", () => {
    expect(parseModelRef("openrouter/openai/gpt-6.1-sol")).toEqual({
      providerID: "openrouter",
      id: "openai/gpt-6.1-sol",
      variant: undefined,
    });
  });

  test("rejects missing provider", () => {
    expect(parseModelRef("claude-opus-4-6")).toBeNull();
    expect(parseModelRef("")).toBeNull();
    expect(parseModelRef("a/")).toBeNull();
  });
});

describe("isDisabledModel", () => {
  test("exact provider/model match blocks at any variant", () => {
    expect(isDisabledModel("anthropic/claude-opus-4-6", ["anthropic/claude-opus-4-6"])).toBe(true);
  });

  test("empty or non-matching list never blocks", () => {
    expect(isDisabledModel("anthropic/claude-sonnet-4-6", [])).toBe(false);
    expect(isDisabledModel("anthropic/claude-sonnet-4-6", ["anthropic/claude-opus-4-6"])).toBe(false);
  });
});

describe("maxUsesExceeded", () => {
  test("absent or zero means unlimited", () => {
    expect(maxUsesExceeded(999, undefined)).toBe(false);
    expect(maxUsesExceeded(999, 0)).toBe(false);
  });

  test("blocks after the cap is reached", () => {
    expect(maxUsesExceeded(2, 3)).toBe(false);
    expect(maxUsesExceeded(3, 3)).toBe(true);
  });
});

describe("parseAdvisorArgs", () => {
  test("parses model and off", () => {
    expect(parseAdvisorArgs("/advisor anthropic/claude-opus-4-6#high")).toEqual({
      action: "set",
      model: "anthropic/claude-opus-4-6#high",
    });
    expect(parseAdvisorArgs("/advisor off")).toEqual({ action: "off" });
    expect(parseAdvisorArgs("/advisor")).toEqual({ action: "show" });
  });
});

describe("buildAdvisorPrompt", () => {
  const tools = ["read", "edit", "advisor"];
  const messages = [
    { type: "user", text: "Add retry logic to fetch.ts" },
    {
      type: "assistant",
      agent: "build",
      content: [
        { type: "text", text: "I will check the file first." },
        { type: "toolcall", id: "call_1", name: "read" },
      ],
    },
    { type: "user", text: "file contents here" },
    {
      type: "assistant",
      agent: "build",
      content: [
        { type: "text", text: "Consulting reviewer." },
        { type: "toolcall", id: "call_advisor_1", name: "advisor" },
      ],
    },
  ];

  test("prepends inventory, serializes branch, strips in-flight call, ends with user turn", () => {
    const prompt = buildAdvisorPrompt(messages, { inflightCallId: "call_advisor_1", toolNames: tools });
    expect(prompt).toContain("Available tools: read, edit, advisor");
    expect(prompt).toContain("Add retry logic to fetch.ts");
    expect(prompt).not.toContain("call_advisor_1");
    expect(prompt).not.toContain("Consulting reviewer.");
    const tail = prompt.trimEnd().split("\n").pop() as string;
    expect(tail.length).toBeGreaterThan(0);
    expect(prompt.trimEnd().endsWith("Please advise on the executor's situation above.")).toBe(true);
  });
});

describe("guidance", () => {
  test("executor guidance tells when to call advisor()", () => {
    expect(EXECUTOR_GUIDANCE).toContain("advisor()");
    expect(EXECUTOR_GUIDANCE).toContain("BEFORE substantive work");
  });

  test("advisor system prompt demands plan/correction/stop only", () => {
    expect(ADVISOR_SYSTEM_PROMPT).toContain("plan");
    expect(ADVISOR_SYSTEM_PROMPT).toContain("NEVER call tools");
  });
});
