import type { Context } from "@opencode/plugin/promise/plugin";
import { EXECUTOR_GUIDANCE, shouldGuide, toRequestSnapshot, type RequestSnapshot } from "./advisor";
import { createAdvisorCommand } from "./command";
import { readConfig, saveConfig, type AdvisorConfig } from "./config";
import { createAdvisorTool } from "./tool";

export default {
  id: "oc-advisor",
  async setup(ctx: Context) {
    const read = (): Promise<AdvisorConfig> => readConfig(ctx.storage, ctx.options);
    const executorKey = (model: any) => `${model?.providerID}/${model?.id}`;
    const snapshots = new Map<string, RequestSnapshot>();

    const advisor = createAdvisorTool({
      loadConfig: read,
      readContext: async (sessionID: string) => ctx.session.context({ sessionID }),
      readRequest: (sessionID: string) => snapshots.get(sessionID),
      contextLimit: async (model: { providerID: string; id: string }) =>
        toArray(await ctx.model.list()).find((m) => m.providerID === model.providerID && m.id === model.id)?.limit
          ?.context,
      listToolNames: async () =>
        toArray(await ctx.tool.list())
          .map((t) => t.id ?? t.name)
          .filter((n) => typeof n === "string"),
      generateText: async (model, prompt, opts) => {
        const result = await ctx.generate.text(
          {
            model: {
              providerID: model.providerID,
              id: model.id,
              ...(model.variant ? { variant: model.variant } : {}),
            },
            prompt,
          },
          opts?.signal ? { signal: opts.signal } : undefined,
        );
        return result?.text ?? "";
      },
    });

    await ctx.tool.transform((editor) => {
      editor.add(advisor.definition as never);
    });

    await ctx.command.transform((editor) => {
      editor.add(
        createAdvisorCommand({
          load: read,
          save: async (c: AdvisorConfig) => saveConfig(ctx.storage, c),
          listModels: async () => ctx.model.list(),
          prompt: async (input: { sessionID: string; text: string; delivery: unknown }) =>
            ctx.session.prompt(input as never),
        }) as never,
      );
    });

    await ctx.session.hook("prompt", async (event) => {
      advisor.resetUses(event.sessionID);
    });

    await ctx.session.hook("context", async (event) => {
      try {
        const e = event as any;
        const config = await read();
        if (!shouldGuide(config, executorKey(e.model), e.model?.variant)) {
          if (e.tools) delete e.tools.advisor;
          return;
        }
        e.system.push({ type: "text", text: EXECUTOR_GUIDANCE });
        snapshots.set(e.sessionID, toRequestSnapshot(e.system, e.tools));
      } catch {
        // Never break the agent loop from a guidance hook.
      }
    });

    return () => {};
  },
};

function toArray(models: unknown): any[] {
  if (Array.isArray(models)) return models as any[];
  const obj = (models ?? {}) as Record<string, any>;
  if (Array.isArray(obj.data)) return obj.data;
  if (Array.isArray(obj.models)) return obj.models;
  return Object.values(obj);
}
