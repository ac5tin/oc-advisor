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
  REVIEW_BUDGET_CHARS,
  reviewBudgetChars,
  runAdvisorCall,
  toRequestSnapshot,
} from "../src/advisor";
import { sanitizeOptions } from "../src/config";
import { createAdvisorCommand } from "../src/command";
import { shouldGuide } from "../src/advisor";

describe("shouldGuide", () => {
  test("false when unconfigured, true when set, false when blocklisted", () => {
    expect(shouldGuide({ model: undefined, disabledForModels: [], maxUses: 0 }, "a/b")).toBe(false);
    expect(shouldGuide({ model: "x/y", disabledForModels: [], maxUses: 0 }, "a/b")).toBe(true);
    expect(shouldGuide({ model: "x/y", disabledForModels: ["a/b"], maxUses: 0 }, "a/b")).toBe(false);
  });

  test("minEffort blocks only at or above the threshold", () => {
    const config = { model: "x/y", disabledForModels: [{ model: "a/b", minEffort: "high" }], maxUses: 0 };
    expect(shouldGuide(config, "a/b", "medium")).toBe(true);
    expect(shouldGuide(config, "a/b", "high")).toBe(false);
    expect(shouldGuide(config, "a/b", "max")).toBe(false);
    expect(shouldGuide(config, "a/b", undefined)).toBe(true);
  });
});
import { createAdvisorTool } from "../src/tool";
import { applyOptions, readConfig, resolveConfig } from "../src/config";

describe("advisor tool gating", () => {
  const branch = [{ id: "m1", type: "user", text: "go" }];
  const host = (config: unknown, used = 0) => {
    let calls = used;
    const h = {
      loadConfig: async () => config,
      readContext: async () => branch,
      listToolNames: async () => ["advisor"],
      generateText: async () => "guidance",
      _calls: () => calls,
      _use: () => {
        calls += 1;
      },
    };
    return h;
  };

  test("no model configured", async () => {
    const t = createAdvisorTool(host({ model: undefined, disabledForModels: [], maxUses: 0 }) as any);
    const r = await t.definition.execute({}, { sessionID: "s", id: "c" });
    expect(r.content).toContain("No advisor model");
  });

  test("misconfigured model", async () => {
    const t = createAdvisorTool(host({ model: "nope", disabledForModels: [], maxUses: 0 }) as any);
    const r = await t.definition.execute({}, { sessionID: "s", id: "c" });
    expect(r.content).toContain("misconfigured");
  });

  test("maxUses enforced then reset", async () => {
    const h = host({ model: "p/m", disabledForModels: [], maxUses: 1 });
    const t = createAdvisorTool(h as any);
    const ok = await t.definition.execute({}, { sessionID: "s", id: "c1" });
    expect(ok.content).toBe("guidance");
    const capped = await t.definition.execute({}, { sessionID: "s", id: "c2" });
    expect(capped.content).toContain("max_uses_exceeded");
    t.resetUses("s");
    const again = await t.definition.execute({}, { sessionID: "s", id: "c3" });
    expect(again.content).toBe("guidance");
  });
});

describe("readConfig", () => {
  test("a write between two reads is visible on the second read", async () => {
    const store = new Map<string, unknown>();
    const storage = {
      get: async (k: string) => store.get(k),
      set: async (k: string, v: unknown) => {
        store.set(k, v);
      },
    };
    expect((await readConfig(storage, undefined)).model).toBeUndefined();
    store.set("config", { model: "xai/grok-4.7#xhigh", disabledForModels: [], maxUses: 0 });
    expect((await readConfig(storage, undefined)).model).toBe("xai/grok-4.7#xhigh");
  });

  test("options override stored values on every read", async () => {
    const storage = { get: async () => ({ model: "a/b", disabledForModels: [], maxUses: 0 }) };
    const cfg = await readConfig(storage, { model: "c/d#high" });
    expect(cfg.model).toBe("c/d#high");
  });
});

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

  test("object entry without minEffort blocks at any effort", () => {
    expect(isDisabledModel("a/b", [{ model: "a/b" }], "low")).toBe(true);
  });

  test("minEffort entry blocks at or above the threshold only", () => {
    const list = [{ model: "a/b", minEffort: "high" }];
    expect(isDisabledModel("a/b", list, "medium")).toBe(false);
    expect(isDisabledModel("a/b", list, "high")).toBe(true);
    expect(isDisabledModel("a/b", list, "xhigh")).toBe(true);
    expect(isDisabledModel("a/b", list, undefined)).toBe(false);
    expect(isDisabledModel("a/b", list, "ultra")).toBe(false);
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
  const tools = [{ name: "read" }, { name: "edit" }, { name: "advisor" }];
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

  test("lists tools, serializes branch, strips the advisor call, ends with user turn", () => {
    const prompt = buildAdvisorPrompt(messages, { inflightCallId: "call_advisor_1", tools });
    expect(prompt).toContain("## tools:\n- advisor\n- edit\n- read");
    expect(prompt).toContain("Add retry logic to fetch.ts");
    expect(prompt).not.toContain("call_advisor_1");
    expect(prompt.trimEnd().endsWith("Please advise on the executor's situation above.")).toBe(true);
  });

  test("keeps the executor's text from the message that made the advisor call", () => {
    const prompt = buildAdvisorPrompt(messages, { inflightCallId: "call_advisor_1", tools });
    expect(prompt).toContain("Consulting reviewer.");
  });

  test("renders the system prompt and tool schemas when provided", () => {
    const prompt = buildAdvisorPrompt(messages, {
      inflightCallId: "call_advisor_1",
      system: "Project rule: use bun.",
      tools: [{ name: "read", description: "Read a file", input: { type: "object" } }],
    });
    expect(prompt).toContain("## system (executor's system prompt, addressed to the executor, not you):\nProject rule: use bun.");
    expect(prompt).toContain('- read: Read a file\n  input: {"type":"object"}');
  });

  test("elides long tool results only when the transcript is over budget", () => {
    const branch = [
      { type: "assistant", agent: "build", content: [{ type: "tool", id: "c1", name: "read", result: "x".repeat(20_000) }] },
    ];
    expect(buildAdvisorPrompt(branch, { tools })).not.toContain("[elided");
    const trimmed = buildAdvisorPrompt(branch, { tools, budgetChars: 5_000 });
    expect(trimmed).toContain("[elided");
    expect(trimmed.length).toBeLessThan(10_000);
  });

  test("keeps the first real user message even when a synthetic message comes first", () => {
    const messages = [
      { type: "synthetic", text: `SYNTH ${"s".repeat(3000)}` },
      { type: "user", text: "the task" },
      ...Array.from({ length: 30 }, (_, i) => ({
        type: "assistant",
        agent: "build",
        content: [{ type: "text", text: `turn-${i} ${"y".repeat(1000)}` }],
      })),
    ];
    const prompt = buildAdvisorPrompt(messages, { tools, budgetChars: 5000 });
    expect(prompt).toContain("the task");
    expect(prompt).not.toContain("SYNTH");
    expect(prompt).toContain("turn-29");
  });

  test("drops the oldest turns to fit the budget, keeping the task and newest turns", () => {
    const turns = Array.from({ length: 30 }, (_, i) => ({
      type: "assistant",
      agent: "build",
      content: [{ type: "text", text: `turn-${i} ${"y".repeat(1000)}` }],
    }));
    const prompt = buildAdvisorPrompt([{ type: "user", text: "the task" }, ...turns], { tools, budgetChars: 5000 });
    expect(prompt).toContain("the task");
    expect(prompt).toContain("turn-29");
    expect(prompt).not.toContain("turn-10 ");
    expect(prompt).toContain("earlier messages omitted");
  });
});

describe("reviewBudgetChars", () => {
  test("derives the budget from the reviewer's context window", () => {
    expect(reviewBudgetChars(200_000)).toBe(420_000);
  });

  test("falls back to a fixed budget when the window is unknown", () => {
    expect(reviewBudgetChars(undefined)).toBe(REVIEW_BUDGET_CHARS);
    expect(reviewBudgetChars(0)).toBe(REVIEW_BUDGET_CHARS);
  });
});

describe("toRequestSnapshot", () => {
  test("joins system text and maps tool definitions", () => {
    expect(
      toRequestSnapshot([{ type: "text", text: "A" }, { type: "text", text: "B" }], {
        read: { description: "Read", input: { type: "object" } },
      }),
    ).toEqual({
      system: "A\n\nB",
      tools: [{ name: "read", description: "Read", input: { type: "object" } }],
    });
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
    expect(seen.prompt).toContain("- read");
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
    expect(seen).toContain("- advisor");
  });

  test("uses the captured request snapshot when available", async () => {
    let seen = "";
    await runAdvisorCall(
      {
        ...deps(),
        readRequest: () => ({ system: "Rule: be terse.", tools: [{ name: "edit", description: "Edit files" }] }),
        generateText: async (_m: any, p: string) => {
          seen = p;
          return "ok";
        },
      },
      { sessionID: "s1", callId: "call_9", ref: { providerID: "p", id: "s" } },
    );
    expect(seen).toContain("## system (executor's system prompt, addressed to the executor, not you):\nRule: be terse.");
    expect(seen).toContain("- edit: Edit files");
    expect(seen).not.toContain("- read");
  });

  test("sizes the transcript budget from the reviewer's context limit", async () => {
    let seen = "";
    await runAdvisorCall(
      {
        readContext: async () => [
          { id: "m1", type: "user", text: "the task" },
          { id: "m2", type: "assistant", agent: "build", content: [{ type: "text", text: `big ${"z".repeat(800)}` }] },
        ],
        listToolNames: async () => ["advisor"],
        contextLimit: async () => 100,
        generateText: async (_m: any, p: string) => {
          seen = p;
          return "ok";
        },
      },
      { sessionID: "s1", callId: "x", ref: { providerID: "p", id: "s" } },
    );
    expect(seen).not.toContain("big zzz");
    expect(seen).toContain("the task");
  });

  test("forwards tool results and the abort signal", async () => {
    let seen = { model: {}, prompt: "", signal: undefined as unknown };
    const text = await runAdvisorCall(
      {
        readContext: async () => [
          { id: "m1", type: "user", text: "go" },
          {
            id: "m2",
            type: "assistant",
            agent: "build",
            content: [
              { type: "tool", id: "c1", name: "read", state: { status: "completed", input: {}, content: [{ type: "text", text: "bytes" }] } },
            ],
          },
        ],
        listToolNames: async () => ["read", "advisor"],
        generateText: async (model: any, prompt: string, opts?: { signal?: unknown }) => {
          seen = { model, prompt, signal: opts?.signal };
          return "plan";
        },
      },
      { sessionID: "s1", callId: "call_9", ref: { providerID: "p", id: "s" }, signal: "sig" as any },
    );
    expect(text).toBe("plan");
    expect(seen.prompt).toContain("bytes");
    expect(seen.signal).toBe("sig");
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

  test("extracts tool call input and completed result text", () => {
    const out = normalizeBranch([
      {
        id: "m",
        type: "assistant",
        agent: "build",
        content: [
          {
            type: "tool",
            id: "call_1",
            name: "read",
            state: { status: "completed", input: { path: "x.ts" }, content: [{ type: "text", text: "file-bytes" }] },
          },
        ],
      },
    ]);
    expect(out[0].content?.[0].input).toBe('{"path":"x.ts"}');
    expect(out[0].content?.[0].result).toBe("file-bytes");
  });

  test("extracts tool error message as result", () => {
    const out = normalizeBranch([
      {
        id: "m",
        type: "assistant",
        agent: "build",
        content: [
          { type: "tool", id: "call_2", name: "shell", state: { status: "error", input: { cmd: "nope" }, error: { message: "boom" } } },
        ],
      },
    ]);
    expect(out[0].content?.[0].result).toContain("boom");
  });
});

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
  test("accepts object blocklist entries with a valid minEffort", () => {
    expect(
      sanitizeOptions({
        disabledForModels: [{ model: "a/b", minEffort: "high" }, { model: "c/d" }, { model: "e/f", minEffort: "ultra" }, { model: 5 }],
      }).disabledForModels,
    ).toEqual([{ model: "a/b", minEffort: "high" }, { model: "c/d" }]);
  });

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

  test("executor guidance keeps the Claude Code conflict-reconciliation sentence", () => {
    expect(EXECUTOR_GUIDANCE).toContain("The advisor saw your evidence but may have underweighted it;");
  });

  test("reviewer prompt tells the reviewer to stay silent when the executor is on track", () => {
    expect(ADVISOR_SYSTEM_PROMPT).toContain("Stay silent when the executor is on track");
  });

  test("advisor system prompt demands plan/correction/stop only", () => {
    expect(ADVISOR_SYSTEM_PROMPT).toContain("plan");
    expect(ADVISOR_SYSTEM_PROMPT).toContain("NEVER call tools");
  });
});
