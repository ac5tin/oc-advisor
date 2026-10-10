import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import plugin from "../src/index";

function eventStream() {
  const queue: any[] = [];
  let wake: (() => void) | undefined;
  async function* iterate() {
    while (true) {
      while (queue.length) yield queue.shift();
      await new Promise<void>((resolve) => (wake = resolve));
    }
  }
  return {
    emit: (event: any) => {
      queue.push(event);
      wake?.();
      wake = undefined;
    },
    subscribe: () => iterate(),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

function setup(options: Record<string, unknown>, directory = "/tmp/opencode") {
  const hooks: Record<string, (event: any) => Promise<void>> = {};
  const registry: Record<string, any> = {};
  const generated: string[] = [];
  const synthetics: any[] = [];
  const sessions: Record<string, any> = {};
  const events = eventStream();
  let reviewText = "[concern] Check the cache key.";
  const ctx: any = {
    location: { directory },
    storage: { get: async () => undefined, set: async () => {} },
    options,
    event: { subscribe: events.subscribe },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => sessions[sessionID],
      context: async () => [{ id: "m1", type: "user", text: "fix the bug" }],
      hook: async (name: string, cb: (event: any) => Promise<void>) => {
        hooks[name] = cb;
        return { dispose: async () => {} };
      },
      synthetic: async (input: any) => {
        synthetics.push(input);
      },
    },
    tool: {
      list: async () => [],
      transform: async (cb: (editor: any) => void) => cb({ add: (t: any) => (registry[t.name] = t) }),
    },
    command: { transform: async () => {} },
    model: { list: async () => [] },
    generate: {
      text: async (req: { prompt: string }) => {
        generated.push(req.prompt);
        return { text: reviewText };
      },
    },
  };
  return {
    ctx,
    hooks,
    registry,
    generated,
    synthetics,
    sessions,
    emit: events.emit,
    setReview: (text: string) => (reviewText = text),
  };
}

const event = (variant?: string, providerID = "p", id = "fast") => ({
  sessionID: "s1",
  model: { providerID, id, ...(variant ? { variant } : {}) },
  system: [{ type: "text", text: "Base rules" }],
  tools: {
    read: { description: "Read a file", input: { type: "object" } },
    advisor: { description: "advisor", input: { type: "object" } },
  },
});

const run = (sessionID = "s1") => ({ type: "session.execution.succeeded", data: { sessionID } });

describe("context hook", () => {
  test("keeps the advisor tool and guidance for an allowed executor", async () => {
    const s = setup({ model: "p/strong" });
    await plugin.setup(s.ctx);
    const e = event();
    await s.hooks.context!(e);
    expect(e.tools.advisor).toBeDefined();
    expect(e.system.length).toBe(2);
    const result = await s.registry.advisor.execute({}, { sessionID: "s1", id: "c1" });
    expect(result.content).toBe("[concern] Check the cache key.");
    expect(s.generated[0]).toContain("- read: Read a file");
    expect(s.generated[0]).toContain("fix the bug");
  });

  test("removes the advisor tool when no model is configured", async () => {
    const s = setup({});
    await plugin.setup(s.ctx);
    const e = event();
    await s.hooks.context!(e);
    expect(e.tools.advisor).toBeUndefined();
    expect(e.tools.read).toBeDefined();
    expect(e.system.length).toBe(1);
  });

  test("removes the advisor tool for a blocklisted executor", async () => {
    const s = setup({ model: "p/strong", disabledForModels: ["p/fast"] });
    await plugin.setup(s.ctx);
    const e = event();
    await s.hooks.context!(e);
    expect(e.tools.advisor).toBeUndefined();
    expect(e.system.length).toBe(1);
  });

  test("applies minEffort to the executor's variant", async () => {
    const s = setup({ model: "p/strong", disabledForModels: [{ model: "p/fast", minEffort: "high" }] });
    await plugin.setup(s.ctx);
    const medium = event("medium");
    await s.hooks.context!(medium);
    expect(medium.tools.advisor).toBeDefined();
    const xhigh = event("xhigh");
    await s.hooks.context!(xhigh);
    expect(xhigh.tools.advisor).toBeUndefined();
  });

  test("mainAgentOnly removes the advisor tool in a child session", async () => {
    const s = setup({ model: "p/strong", mainAgentOnly: true });
    await plugin.setup(s.ctx);
    s.sessions.s1 = { id: "s1", parentID: "ses_parent" };
    const e = event();
    await s.hooks.context!(e);
    expect(e.tools.advisor).toBeUndefined();
    expect(e.tools.read).toBeDefined();
    expect(e.system.length).toBe(1);
  });

  test("mainAgentOnly keeps the advisor tool in the main session", async () => {
    const s = setup({ model: "p/strong", mainAgentOnly: true });
    await plugin.setup(s.ctx);
    const e = event();
    await s.hooks.context!(e);
    expect(e.tools.advisor).toBeDefined();
    expect(e.system.length).toBe(2);
  });

  test("children keep the advisor tool when mainAgentOnly is not set", async () => {
    const s = setup({ model: "p/strong" });
    await plugin.setup(s.ctx);
    s.sessions.s1 = { id: "s1", parentID: "ses_parent" };
    const e = event();
    await s.hooks.context!(e);
    expect(e.tools.advisor).toBeDefined();
    expect(e.system.length).toBe(2);
  });

  test("mainAgentOnly keeps the advisor tool when parentID is missing", async () => {
    const s = setup({ model: "p/strong", mainAgentOnly: true });
    await plugin.setup(s.ctx);
    s.sessions.s1 = { id: "s1" };
    const e = event();
    await s.hooks.context!(e);
    expect(e.tools.advisor).toBeDefined();
    expect(e.system.length).toBe(2);
  });

  test("mainAgentOnly keeps the advisor tool when parentID is null", async () => {
    const s = setup({ model: "p/strong", mainAgentOnly: true });
    await plugin.setup(s.ctx);
    s.sessions.s1 = { id: "s1", parentID: null };
    const e = event();
    await s.hooks.context!(e);
    expect(e.tools.advisor).toBeDefined();
    expect(e.system.length).toBe(2);
  });
});

describe("push mode", () => {
  test("off by default: a finished run never triggers a review", async () => {
    const s = setup({ model: "p/strong" });
    await plugin.setup(s.ctx);
    await s.hooks.context!(event());
    s.emit(run());
    await flush();
    expect(s.generated.length).toBe(0);
    expect(s.synthetics.length).toBe(0);
  });

  test("agent-end posts a labelled, queued note that does not resume the run", async () => {
    const s = setup({ model: "p/strong", push: { mode: "agent-end" } });
    await plugin.setup(s.ctx);
    await s.hooks.context!(event());
    s.emit(run());
    await flush();
    expect(s.synthetics).toEqual([
      {
        sessionID: "s1",
        text: "Advisor note (concern): Check the cache key.",
        delivery: "queue",
        resume: false,
      },
    ]);
  });

  test("nits are not pushed under the default concern floor", async () => {
    const s = setup({ model: "p/strong", push: { mode: "agent-end" } });
    s.setReview("Consider a helper.");
    await plugin.setup(s.ctx);
    await s.hooks.context!(event());
    s.emit(run());
    await flush();
    expect(s.synthetics.length).toBe(0);
  });

  test("silent reviews are never pushed", async () => {
    const s = setup({ model: "p/strong", push: { mode: "agent-end", minSeverity: "nit" } });
    s.setReview("SILENT");
    await plugin.setup(s.ctx);
    await s.hooks.context!(event());
    s.emit(run());
    await flush();
    expect(s.synthetics.length).toBe(0);
  });

  test("cooldown skips agent-end runs after a push", async () => {
    const s = setup({ model: "p/strong", push: { mode: "agent-end", cooldownTurns: 2, maxPerPrompt: 9 } });
    await plugin.setup(s.ctx);
    await s.hooks.context!(event());
    s.emit(run());
    await flush();
    s.emit(run());
    s.emit(run());
    await flush();
    expect(s.synthetics.length).toBe(1);
    s.setReview("[concern] A different point.");
    s.emit(run());
    await flush();
    expect(s.synthetics.length).toBe(2);
  });

  test("a repeated note is not posted twice", async () => {
    const s = setup({ model: "p/strong", push: { mode: "agent-end", cooldownTurns: 0, maxPerPrompt: 9 } });
    await plugin.setup(s.ctx);
    await s.hooks.context!(event());
    s.emit(run());
    s.emit(run());
    await flush();
    expect(s.synthetics.length).toBe(1);
  });

  test("maxPerPrompt holds until the next user prompt resets it", async () => {
    const s = setup({ model: "p/strong", push: { mode: "agent-end", cooldownTurns: 0, maxPerPrompt: 1 } });
    await plugin.setup(s.ctx);
    await s.hooks.context!(event());
    s.emit(run());
    s.emit(run());
    await flush();
    expect(s.synthetics.length).toBe(1);
    await s.hooks.prompt!({ sessionID: "s1" });
    s.setReview("[concern] A different point.");
    s.emit(run());
    await flush();
    expect(s.synthetics.length).toBe(2);
  });

  test("a blocklisted executor is never reviewed", async () => {
    const s = setup({ model: "p/strong", push: { mode: "agent-end" }, disabledForModels: ["p/fast"] });
    await plugin.setup(s.ctx);
    await s.hooks.context!(event());
    s.emit(run());
    await flush();
    expect(s.generated.length).toBe(0);
  });

  test("mainAgentOnly never reviews a child run", async () => {
    const s = setup({ model: "p/strong", mainAgentOnly: true, push: { mode: "agent-end" } });
    await plugin.setup(s.ctx);
    s.sessions.s1 = { id: "s1", parentID: "ses_parent" };
    await s.hooks.context!(event());
    s.emit(run());
    await flush();
    expect(s.generated.length).toBe(0);
    expect(s.synthetics.length).toBe(0);
  });

  test("mainAgentOnly still reviews a main run", async () => {
    const s = setup({ model: "p/strong", mainAgentOnly: true, push: { mode: "agent-end" } });
    await plugin.setup(s.ctx);
    await s.hooks.context!(event());
    s.emit(run());
    await flush();
    expect(s.synthetics.length).toBe(1);
  });

  test("a deleted session is forgotten and no longer reviewed", async () => {
    const s = setup({ model: "p/strong", push: { mode: "agent-end" } });
    await plugin.setup(s.ctx);
    await s.hooks.context!(event());
    s.emit({ type: "session.deleted", data: { sessionID: "s1" } });
    s.emit(run());
    await flush();
    expect(s.generated.length).toBe(0);
  });

  test("project notes are sent to the reviewer only when enabled", async () => {
    const dir = mkdtempSync("/tmp/opencode/index-notes-");
    mkdirSync(join(dir, ".opencode"));
    writeFileSync(join(dir, ".opencode", "advisor.md"), "Prefer small diffs.");
    const s = setup({ model: "p/strong", projectNotes: true }, dir);
    await plugin.setup(s.ctx);
    await s.hooks.context!(event());
    await s.registry.advisor.execute({}, { sessionID: "s1", id: "c1" });
    expect(s.generated[0]).toContain("## Project advisor notes\nPrefer small diffs.");
  });
});

describe("prompt-scoped counters", () => {
  test("a push review does not use the pull-mode call cap", async () => {
    const s = setup({ model: "p/strong", maxUses: 1, push: { mode: "agent-end", cooldownTurns: 0, maxPerPrompt: 9 } });
    await plugin.setup(s.ctx);
    await s.hooks.context!(event());
    s.emit(run());
    await flush();
    const pulled = await s.registry.advisor.execute({}, { sessionID: "s1", id: "c1" });
    expect(pulled.content).toBe("[concern] Check the cache key.");
  });
});
