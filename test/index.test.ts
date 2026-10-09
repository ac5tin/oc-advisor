import { describe, expect, test } from "bun:test";
import plugin from "../src/index";

function setup(options: Record<string, unknown>) {
  const hooks: Record<string, (event: any) => Promise<void>> = {};
  const registry: Record<string, any> = {};
  let prompt = "";
  const ctx: any = {
    storage: { get: async () => undefined, set: async () => {} },
    options,
    session: {
      context: async () => [{ id: "m1", type: "user", text: "fix the bug" }],
      hook: async (name: string, cb: (event: any) => Promise<void>) => {
        hooks[name] = cb;
        return { dispose: async () => {} };
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
        prompt = req.prompt;
        return { text: "plan" };
      },
    },
  };
  return { ctx, hooks, registry, prompt: () => prompt };
}

const event = (variant?: string) => ({
  sessionID: "s1",
  model: { providerID: "p", id: "fast", ...(variant ? { variant } : {}) },
  system: [{ type: "text", text: "Base rules" }],
  tools: {
    read: { description: "Read a file", input: { type: "object" } },
    advisor: { description: "advisor", input: { type: "object" } },
  },
});

describe("context hook", () => {
  test("keeps the advisor tool and guidance for an allowed executor", async () => {
    const s = setup({ model: "p/strong" });
    await plugin.setup(s.ctx);
    const e = event();
    await s.hooks.context!(e);
    expect(e.tools.advisor).toBeDefined();
    expect(e.system.length).toBe(2);
    const result = await s.registry.advisor.execute({}, { sessionID: "s1", id: "c1" });
    expect(result.content).toBe("plan");
    expect(s.prompt()).toContain("- read: Read a file");
    expect(s.prompt()).toContain("fix the bug");
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
});
