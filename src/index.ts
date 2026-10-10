import type { Context } from "@opencode/plugin/promise/plugin";
import {
  EXECUTOR_GUIDANCE,
  parseModelRef,
  shouldGuide,
  toRequestSnapshot,
  type RequestSnapshot,
} from "./advisor";
import { createAdvisorCommand } from "./command";
import { readConfig, saveConfig, type AdvisorConfig } from "./config";
import { readProjectNotes } from "./notes";
import {
  canPush,
  isRepeat,
  newPushState,
  parseReview,
  pushNoteText,
  recordPush,
  resetPrompt,
  shouldPush,
  skipTurn,
  type PushState,
} from "./push";
import { createAdvisorTool } from "./tool";

export default {
  id: "oc-advisor",
  async setup(ctx: Context) {
    const read = (): Promise<AdvisorConfig> => readConfig(ctx.storage, ctx.options);
    const executorKey = (model: any) => `${model?.providerID}/${model?.id}`;
    const snapshots = new Map<string, RequestSnapshot>();
    const executors = new Map<string, { key: string; effort?: string; child: boolean }>();
    const pushStates = new Map<string, PushState>();

    const advisor = createAdvisorTool({
      loadConfig: read,
      readContext: async (sessionID: string) => ctx.session.context({ sessionID }),
      readRequest: (sessionID: string) => snapshots.get(sessionID),
      contextLimit: async (model: { providerID: string; id: string }) =>
        toArray(await ctx.model.list()).find((m) => m.providerID === model.providerID && m.id === model.id)?.limit
          ?.context,
      readProjectNotes: async () => {
        const config = await read();
        return config.projectNotes ? readProjectNotes(ctx.location.directory) : undefined;
      },
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
      const state = pushStates.get(event.sessionID);
      if (state) resetPrompt(state);
    });

    await ctx.session.hook("context", async (event) => {
      try {
        const e = event as any;
        const config = await read();
        const child = config.mainAgentOnly
          ? (await ctx.session.get({ sessionID: e.sessionID }))?.parentID !== undefined
          : false;
        executors.set(e.sessionID, { key: executorKey(e.model), effort: e.model?.variant, child });
        if (child || !shouldGuide(config, executorKey(e.model), e.model?.variant)) {
          if (e.tools) delete e.tools.advisor;
          return;
        }
        e.system.push({ type: "text", text: EXECUTOR_GUIDANCE });
        snapshots.set(e.sessionID, toRequestSnapshot(e.system, e.tools));
      } catch {
        // Never break the agent loop from a guidance hook.
      }
    });

    // Push mode: after a finished run, the reviewer may post one note into the session.
    // Failures are swallowed so a broken review never disturbs the executor.
    const afterRun = async (sessionID: string) => {
      const config = await read();
      if (config.push.mode === "off" || config.model === undefined) return;
      const executor = executors.get(sessionID);
      if (!executor || executor.child || !shouldGuide(config, executor.key, executor.effort)) return;
      const ref = parseModelRef(config.model);
      if (!ref) return;
      const state = pushStates.get(sessionID) ?? newPushState();
      pushStates.set(sessionID, state);
      if (state.cooldown > 0) {
        skipTurn(state);
        return;
      }
      if (!canPush(state, config.push)) return;
      const { severity, body } = parseReview(await advisor.review(sessionID, ref, state.raw));
      if (!shouldPush(severity, config.push.minSeverity) || isRepeat(state, body)) return;
      recordPush(state, body, config.push);
      await ctx.session.synthetic({
        sessionID,
        text: pushNoteText(severity as Exclude<typeof severity, "silent">, body),
        delivery: "queue",
        resume: false,
      });
    };

    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const e = event as any;
          if (e.type === "session.execution.succeeded") {
            await afterRun(e.data.sessionID).catch(() => {});
          } else if (e.type === "session.deleted") {
            const id = e.data.sessionID;
            advisor.forget(id);
            pushStates.delete(id);
            executors.delete(id);
            snapshots.delete(id);
          }
        }
      } catch {
        // The event stream closed or was aborted on unload.
      }
    })();

    return () => controller.abort();
  },
};

function toArray(models: unknown): any[] {
  if (Array.isArray(models)) return models as any[];
  const obj = (models ?? {}) as Record<string, any>;
  if (Array.isArray(obj.data)) return obj.data;
  if (Array.isArray(obj.models)) return obj.models;
  return Object.values(obj);
}
