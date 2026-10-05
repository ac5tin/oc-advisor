import { describe, expect, test } from "bun:test";
import {
  ADVISOR_SYSTEM_PROMPT,
  AdvisorError,
  buildAdvisorPrompt,
  EXECUTOR_GUIDANCE,
  isDisabledModel,
  maxUsesExceeded,
  normalizeBranch,
  parseAdvisorArgs,
  parseModelRef,
  runAdvisorCall,
} from "../src/advisor";
import { sanitizeOptions } from "../src/config";

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
        { type: "tool", id: "call_1", name: "read" },
      ],
    },
    { type: "user", text: "file contents here" },
    {
      type: "assistant",
      agent: "build",
      content: [
        { type: "text", text: "Consulting reviewer." },
        { type: "tool", id: "call_advisor_1", name: "advisor" },
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

describe("runAdvisorCall", () => {
  const branch = [
    { id: "m1", type: "user", text: "Fix the login bug" },
    {
      id: "m2",
      type: "assistant",
      agent: "build",
      model: { providerID: "p", id: "fast" },
      content: [
        { type: "reasoning", text: "Probably the token refresh." },
        { type: "tool", id: "call_9", name: "advisor" },
      ],
    },
  ];
  const deps = (over: Record<string, unknown> = {}) => ({
    readContext: async () => branch,
    listToolNames: async () => ["read", "advisor"],
    generateText: async () => "  Use a refresh lock.  ",
    ...over,
  });

  test("sends inventory + stripped branch with user tail, returns trimmed text", async () => {
    let seen = { model: {}, prompt: "" };
    const text = await runAdvisorCall(
      {
        ...deps(),
        generateText: async (model: any, prompt: string) => {
          seen = { model, prompt };
          return "  Use a refresh lock.  ";
        },
      },
      { sessionID: "s1", callId: "call_9", ref: { providerID: "p", id: "strong" } },
    );
    expect(text).toBe("Use a refresh lock.");
    expect(seen.model).toEqual({ providerID: "p", id: "strong" });
    expect(seen.prompt).toContain("Available tools: read, advisor");
    expect(seen.prompt).not.toContain("call_9");
    expect(seen.prompt.trimEnd().endsWith("Please advise on the executor's situation above.")).toBe(true);
  });

  test("empty reviewer text throws", async () => {
    await expect(
      runAdvisorCall({ ...deps(), generateText: async () => "   " }, { sessionID: "s1", callId: "x", ref: { providerID: "p", id: "s" } }),
    ).rejects.toThrow("no text");
  });

  test("generate failure throws advisor error", async () => {
    await expect(
      runAdvisorCall(
        {
          ...deps(),
          generateText: async () => {
            throw new Error("overloaded");
          },
        },
        { sessionID: "s1", callId: "x", ref: { providerID: "p", id: "s" } },
      ),
    ).rejects.toThrow("Advisor call failed: overloaded");
  });

  test("context failure throws advisor error", async () => {
    await expect(
      runAdvisorCall(
        {
          ...deps(),
          readContext: async () => {
            throw new Error("gone");
          },
        },
        { sessionID: "s1", callId: "x", ref: { providerID: "p", id: "s" } },
      ),
    ).rejects.toThrow("could not read session context");
  });

  test("tool list failure falls back to advisor-only inventory", async () => {
    let seen = "";
    await runAdvisorCall(
      {
        ...deps(),
        listToolNames: async () => {
          throw new Error("nope");
        },
        generateText: async (_m: any, p: string) => {
          seen = p;
          return "ok";
        },
      },
      { sessionID: "s1", callId: "x", ref: { providerID: "p", id: "s" } },
    );
    expect(seen).toContain("Available tools: advisor");
  });
});

describe("normalizeBranch", () => {
  test("maps real session message shapes, non-array to empty", () => {
    expect(normalizeBranch(null)).toEqual([]);
    const out = normalizeBranch([
      { id: "a", type: "user", text: "hi", files: [] },
      { id: "b", type: "assistant", agent: "build", model: { providerID: "p", id: "m" }, content: [{ type: "text", text: "t" }] },
    ]);
    expect(out[0]).toEqual({ type: "user", text: "hi" });
    expect(out[1].agent).toBe("build");
    expect(out[1].content?.length).toBe(1);
  });
});

import { sanitizeOptions } from "../src/config";
import { createAdvisorCommand } from "../src/command";

function fakeCtx() {
  const store = new Map<string, unknown>();
  const prompts: Array<{ sessionID: string; text: string }> = [];
  const host = {
    load: async () => ({
      model: (store.get("config") as any)?.model,
      disabledForModels: [],
      maxUses: 0,
    }),
    save: async (c: unknown) => {
      store.set("config", c);
    },
    listModels: async () => ({
      data: [
        { providerID: "anthropic", id: "claude-opus-4-6", modelID: "claude-opus-4-6", variants: [{ id: "high" }] },
      ],
    }),
    prompt: async (input: any) => {
      prompts.push({ sessionID: input.sessionID, text: input.text });
    },
  };
  return { store, prompts, host };
}

describe("advisor command", () => {
  test("show reports the configured model", async () => {
    const f = fakeCtx();
    f.store.set("config", { model: "anthropic/claude-opus-4-6#high", disabledForModels: [], maxUses: 0 });
    const cmd = createAdvisorCommand(f.host);
    await cmd.execute({ sessionID: "s1", prompt: { text: "/advisor" }, delivery: "steer" } as any);
    expect(f.prompts.length).toBe(1);
    expect(f.prompts[0].text).toContain("Advisor: anthropic/claude-opus-4-6#high");
  });

  test("show reports off when unconfigured", async () => {
    const f = fakeCtx();
    const cmd = createAdvisorCommand(f.host);
    await cmd.execute({ sessionID: "s1", prompt: { text: "/advisor" }, delivery: "steer" } as any);
    expect(f.prompts[0].text).toContain("Advisor: off");
  });

  test("set validates and persists a known model", async () => {
    const f = fakeCtx();
    const cmd = createAdvisorCommand(f.host);
    await cmd.execute({ sessionID: "s1", prompt: { text: "/advisor anthropic/claude-opus-4-6#high" }, delivery: "steer" } as any);
    expect((f.store.get("config") as any).model).toBe("anthropic/claude-opus-4-6#high");
    expect(f.prompts[0].text).toContain("set to anthropic/claude-opus-4-6#high");
  });

  test("set rejects unknown models without saving", async () => {
    const f = fakeCtx();
    const cmd = createAdvisorCommand(f.host);
    await cmd.execute({ sessionID: "s1", prompt: { text: "/advisor nope/nope" }, delivery: "steer" } as any);
    expect(f.store.get("config")).toBeUndefined();
    expect(f.prompts[0].text).toContain("No model nope/nope found");
  });

  test("set rejects unsupported variants", async () => {
    const f = fakeCtx();
    const cmd = createAdvisorCommand(f.host);
    await cmd.execute({ sessionID: "s1", prompt: { text: "/advisor anthropic/claude-opus-4-6#ultra" }, delivery: "steer" } as any);
    expect(f.store.get("config")).toBeUndefined();
    expect(f.prompts[0].text).toContain("high");
  });

  test("off clears the model", async () => {
    const f = fakeCtx();
    f.store.set("config", { model: "anthropic/claude-opus-4-6", disabledForModels: [], maxUses: 0 });
    const cmd = createAdvisorCommand(f.host);
    await cmd.execute({ sessionID: "s1", prompt: { text: "/advisor off" }, delivery: "steer" } as any);
    expect((f.store.get("config") as any).model).toBeUndefined();
    expect(f.prompts[0].text).toContain("disabled");
  });
});
describe("sanitizeOptions", () => {
  test("accepts model, blocklist, and positive maxUses", () => {
    expect(
      sanitizeOptions({ model: "anthropic/claude-opus-4-6#high", disabledForModels: ["a/b"], maxUses: 3 }),
    ).toEqual({ model: "anthropic/claude-opus-4-6#high", disabledForModels: ["a/b"], maxUses: 3 });
  });

  test("drops invalid model, non-string entries, and non-positive maxUses", () => {
    expect(sanitizeOptions({ model: "nope", disabledForModels: ["a/b", 42, ""], maxUses: -1 })).toEqual({
      model: undefined,
      disabledForModels: ["a/b"],
      maxUses: 0,
    });
    expect(sanitizeOptions(undefined)).toEqual({ model: undefined, disabledForModels: [], maxUses: 0 });
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
