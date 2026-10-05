import { Plugin } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";
import { EXECUTOR_GUIDANCE, isDisabledModel } from "./advisor";
import { createAdvisorCommand } from "./command";
import { readConfig, saveConfig, type AdvisorConfig } from "./config";
import { createAdvisorTool } from "./tool";

const ADVISOR_TOOL = "advisor";

export default Plugin.define({
  id: "oc-advisor",
  async setup(ctx: Context) {
    const read = (): Promise<AdvisorConfig> => readConfig(ctx.storage, ctx.options);
    const executorKey = (model: any) => `${model?.providerID}/${model?.id}`;
    const advisorActive = async (model: any): Promise<boolean> => {
      const config = await read();
      return config.model !== undefined && !isDisabledModel(executorKey(model), config.disabledForModels);
    };

    const advisor = createAdvisorTool({
      loadConfig: read,
      readContext: async (sessionID: string) => ctx.session.context({ sessionID }),
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
        if (!(await advisorActive((event as any).model))) {
          if ((event as any).tools) delete (event as any).tools[ADVISOR_TOOL];
          return;
        }
        (event as any).system.push({ type: "text", text: EXECUTOR_GUIDANCE });
      } catch {
        // Never break the agent loop from a guidance hook.
      }
    });

    return () => {};
  },
});

function toArray(models: unknown): any[] {
  if (Array.isArray(models)) return models as any[];
  const obj = (models ?? {}) as Record<string, any>;
  if (Array.isArray(obj.data)) return obj.data;
  if (Array.isArray(obj.models)) return obj.models;
  return Object.values(obj);
}
