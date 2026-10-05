import { Plugin } from "@opencode/plugin";
import {
  AdvisorError,
  EXECUTOR_GUIDANCE,
  isDisabledModel,
  maxUsesExceeded,
  parseModelRef,
  runAdvisorCall,
} from "./advisor";
import { applyOptions, resolveConfig, saveConfig, type AdvisorConfig } from "./config";
import { createAdvisorCommand } from "./command";

const ADVISOR_TOOL = "advisor";

const SHORT_DESCRIPTION =
  "Escalate to a stronger reviewer model for guidance. Takes NO parameters — your entire conversation is forwarded automatically. Call BEFORE substantive work, when stuck, or before declaring done.";

function toArray(models: unknown): any[] {
  if (Array.isArray(models)) return models as any[];
  const obj = (models ?? {}) as Record<string, any>;
  if (Array.isArray(obj.data)) return obj.data;
  if (Array.isArray(obj.models)) return obj.models;
  return Object.values(obj);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default Plugin.define({
  id: "oc-advisor",
  async setup(ctx: any) {
    let current: AdvisorConfig = applyOptions(await resolveConfig(ctx.storage), ctx.options);
    const uses = new Map<string, number>();

    const executorKey = (model: any) => `${model?.providerID}/${model?.id}`;
    const advisorActive = (model: any) =>
      current.model !== undefined && !isDisabledModel(executorKey(model), current.disabledForModels);

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: ADVISOR_TOOL,
        description: SHORT_DESCRIPTION,
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async (_input: unknown, context: any) => {
          const sessionID = context.sessionID as string;
          if (!current.model) {
            return { content: "No advisor model is configured. The user can enable one with the /advisor command." };
          }
          const ref = parseModelRef(current.model);
          if (!ref) {
            return { content: `Advisor model is misconfigured: ${current.model}. Fix it with /advisor.` };
          }
          const used = uses.get(sessionID) ?? 0;
          if (maxUsesExceeded(used, current.maxUses)) {
            return { content: "Advisor call limit reached (max_uses_exceeded). Continuing without further advice." };
          }
          uses.set(sessionID, used + 1);
          try {
            const text = await runAdvisorCall(
              {
                readContext: async (id) => ctx.session.context({ sessionID: id }),
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
              },
              { sessionID, callId: context.id, ref, signal: context.signal },
            );
            return { content: text };
          } catch (e) {
            return { content: e instanceof AdvisorError ? e.message : `Advisor call failed: ${errText(e)}` };
          }
        },
      });
    });

    await ctx.command.transform((editor: any) => {
      editor.add(
        createAdvisorCommand({
          load: async () => current,
          save: async (c: AdvisorConfig) => {
            current = c;
            await saveConfig(ctx.storage, c);
          },
          listModels: async () => ctx.model.list(),
          prompt: async (input: { sessionID: string; text: string; delivery: unknown }) =>
            ctx.session.prompt(input),
        }),
      );
    });

    await ctx.session.hook("prompt", async (event: any) => {
      uses.set(event.sessionID, 0);
    });

    await ctx.session.hook("context", async (event: any) => {
      try {
        if (!advisorActive(event.model)) {
          if (event.tools) delete event.tools[ADVISOR_TOOL];
          return;
        }
        event.system.push({ type: "text", text: EXECUTOR_GUIDANCE });
      } catch {
        // Never break the agent loop from a guidance hook.
      }
    });

    return () => {
      uses.clear();
    };
  },
});
