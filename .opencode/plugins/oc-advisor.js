// src/index.ts
import { Plugin } from "@opencode/plugin";

// src/advisor.ts
function parseModelRef(raw) {
  const text = raw.trim();
  if (!text)
    return null;
  const hash = text.indexOf("#");
  const main = (hash === -1 ? text : text.slice(0, hash)).trim();
  const variant = hash === -1 ? undefined : text.slice(hash + 1).trim() || undefined;
  const slash = main.indexOf("/");
  if (slash <= 0)
    return null;
  const providerID = main.slice(0, slash).trim();
  const id = main.slice(slash + 1).trim();
  if (!providerID || !id)
    return null;
  return variant === undefined ? { providerID, id } : { providerID, id, variant };
}
function canonicalKey(ref) {
  const parsed = parseModelRef(ref);
  if (!parsed)
    return ref.trim();
  return `${parsed.providerID}/${parsed.id}`;
}
function isDisabledModel(executorRef, disabledForModels) {
  const key = canonicalKey(executorRef);
  return disabledForModels.some((entry) => canonicalKey(entry) === key);
}
function maxUsesExceeded(used, maxUses) {
  if (maxUses === undefined || maxUses <= 0)
    return false;
  return used >= maxUses;
}
function parseAdvisorArgs(text) {
  const rest = text.replace(/^\s*\/advisor\b\s*/, "").trim();
  if (!rest)
    return { action: "show" };
  if (rest.toLowerCase() === "off")
    return { action: "off" };
  return { action: "set", model: rest };
}

class AdvisorError extends Error {
}
async function runAdvisorCall(deps, input) {
  const messages = await deps.readContext(input.sessionID).catch((e) => {
    throw new AdvisorError(`could not read session context: ${e instanceof Error ? e.message : String(e)}`);
  });
  const toolNames = await deps.listToolNames().catch(() => ["advisor"]);
  const branch = buildAdvisorPrompt(normalizeBranch(messages), {
    inflightCallId: input.callId,
    toolNames
  });
  const text = await deps.generateText(input.ref, `${ADVISOR_SYSTEM_PROMPT}

${branch}`).catch((e) => {
    throw new AdvisorError(`Advisor call failed: ${e instanceof Error ? e.message : String(e)}`);
  });
  if (!text.trim())
    throw new AdvisorError("Advisor returned no text content.");
  return text.trim();
}
function normalizeBranch(messages) {
  if (!Array.isArray(messages))
    return [];
  return messages.map((m) => {
    const content = Array.isArray(m.content) ? m.content.map((p) => ({ type: p.type, text: p.text, id: p.id, name: p.name })) : undefined;
    const out = { type: String(m.type ?? "unknown") };
    if (typeof m.text === "string")
      out.text = m.text;
    if (typeof m.agent === "string")
      out.agent = m.agent;
    if (m.model && typeof m.model === "object")
      out.model = { providerID: m.model.providerID, id: m.model.id };
    if (content)
      out.content = content;
    return out;
  });
}
function renderMessage(msg, inflightCallId) {
  if (msg.type === "user" || msg.type === "synthetic") {
    if (!msg.text)
      return null;
    return `## ${msg.type}:
${msg.text}`;
  }
  const parts = (msg.content ?? []).filter((p) => p.id !== inflightCallId);
  if (msg.content !== undefined && msg.content.some((p) => p.id === inflightCallId))
    return null;
  const who = msg.agent ?? (msg.model ? `${msg.model.providerID}/${msg.model.id}` : "assistant");
  const lines = [];
  for (const p of parts) {
    if (typeof p.text === "string" && p.text)
      lines.push(p.text);
    else if (p.name)
      lines.push(`tool call ${p.name}${p.id ? ` (${p.id})` : ""}`);
  }
  if (msg.text && lines.length === 0)
    lines.push(msg.text);
  if (lines.length === 0)
    return null;
  return `## assistant (${who}):
${lines.join(`
`)}`;
}
function buildAdvisorPrompt(messages, opts) {
  const out = [`Available tools: ${opts.toolNames.join(", ")}`, ""];
  let lastWasUser = false;
  for (const msg of messages) {
    const rendered = renderMessage(msg, opts.inflightCallId);
    if (!rendered) {
      lastWasUser = false;
      continue;
    }
    out.push(rendered, "");
    lastWasUser = msg.type === "user";
  }
  if (!lastWasUser)
    out.push(`## user:
Please advise on the executor's situation above.`);
  return out.join(`
`);
}
var EXECUTOR_GUIDANCE = `You have access to an \`advisor\` tool backed by a stronger reviewer model. It takes NO parameters — when you call advisor(), your entire conversation history is automatically forwarded. They see the task, every tool call you've made, every result you've seen.

Call advisor BEFORE substantive work — before writing, before committing to an interpretation, before building on an assumption. If the task requires orientation first (finding files, fetching a source, seeing what's there), do that, then call advisor. Orientation is not substantive work. Writing, editing, and declaring an answer are.

Also call advisor:
- When you believe the task is complete. BEFORE this call, make your deliverable durable: write the file, save the result, commit the change. The advisor call takes time; if the session ends during it, a durable result persists and an unwritten one doesn't.
- When stuck — errors recurring, approach not converging, results that don't fit.
- When considering a change of approach.

On tasks longer than a few steps, call advisor at least once before committing to an approach and once before declaring done. On short reactive tasks where the next action is dictated by tool output you just read, you don't need to keep calling — the advisor adds most of its value on the first call, before the approach crystallizes.

Give the advice serious weight. If you follow a step and it fails empirically, or you have primary-source evidence that contradicts a specific claim (the file says X, the paper states Y), adapt. A passing self-test is not evidence the advice is wrong — it's evidence your test doesn't check what the advice is checking.

If you've already retrieved data pointing one way and the advisor points another: don't silently switch. Surface the conflict in one more advisor call — "I found X, you suggest Y, which constraint breaks the tie?" A reconcile call is cheaper than committing to the wrong branch.

After each advisor result, put the advisor's key guidance into your next visible reply to the user before continuing — quote or paraphrase the plan, correction, or stop signal. The user often cannot see collapsed tool results; do not keep the advisor's words only in silent tool context.`;
var ADVISOR_SYSTEM_PROMPT = `You are an advisor model in an advisor-strategy pattern. An executor model is running a task end-to-end — calling tools, reading results, iterating toward a solution. When the executor hits a decision it cannot reasonably solve alone, it consults you for guidance. The executor's full tool inventory is prepended before the conversation so you can judge tool-choice correctness.

You read the shared conversation context and return ONE of:
- a plan (concrete next steps the executor should take),
- a correction (the executor is going down a wrong path — redirect it),
- a stop signal (the executor should halt and escalate to the user).

You NEVER call tools. You NEVER produce user-facing output. Be concise, directive, and grounded in the shared context. Name files, functions, and line numbers where possible. No preamble, no apologies, no meta-commentary about being an advisor — just the guidance the executor needs.`;

// src/config.ts
var DEFAULT_CONFIG = { model: undefined, disabledForModels: [], maxUses: 0 };
function sanitizeOptions(raw) {
  const out = { ...DEFAULT_CONFIG, disabledForModels: [] };
  if (!raw || typeof raw !== "object")
    return out;
  if (typeof raw.model === "string" && parseModelRef(raw.model))
    out.model = raw.model.trim();
  if (Array.isArray(raw.disabledForModels)) {
    out.disabledForModels = raw.disabledForModels.filter((e) => typeof e === "string" && parseModelRef(e) !== null);
  }
  if (typeof raw.maxUses === "number" && Number.isFinite(raw.maxUses) && raw.maxUses > 0) {
    out.maxUses = Math.floor(raw.maxUses);
  }
  return out;
}
function sanitizeStored(raw) {
  if (!raw || typeof raw !== "object")
    return {};
  return sanitizeOptions(raw);
}
async function resolveConfig(storage) {
  const stored = sanitizeStored(await storage.get("config"));
  return { ...DEFAULT_CONFIG, ...stored };
}
function applyOptions(base, raw) {
  const opts = sanitizeOptions(raw);
  const out = { ...base };
  if (opts.model !== undefined)
    out.model = opts.model;
  if (raw && typeof raw === "object" && Array.isArray(raw.disabledForModels)) {
    out.disabledForModels = opts.disabledForModels;
  }
  if (opts.maxUses > 0)
    out.maxUses = opts.maxUses;
  return out;
}
async function saveConfig(storage, config) {
  await storage.set("config", config);
}

// src/command.ts
function toArray(models) {
  if (Array.isArray(models))
    return models;
  const obj = models ?? {};
  if (Array.isArray(obj.data))
    return obj.data;
  if (Array.isArray(obj.models))
    return obj.models;
  return Object.values(obj);
}
function createAdvisorCommand(host) {
  return {
    name: "advisor",
    description: "Select the advisor reviewer model: /advisor provider/model[#variant], /advisor off",
    execute: async ({ sessionID, prompt, delivery }) => {
      const reply = (text) => host.prompt({ sessionID, text, delivery });
      const config = await host.load();
      const arg = parseAdvisorArgs(prompt?.text ?? "");
      if (arg.action === "show") {
        await reply(config.model ? `Advisor: ${config.model}${config.maxUses > 0 ? ` (max ${config.maxUses} calls per request)` : ""}` : "Advisor: off. Set one with /advisor provider/model[#variant], e.g. /advisor anthropic/claude-opus-4-6#high");
        return;
      }
      if (arg.action === "off") {
        await host.save({ ...config, model: undefined });
        await reply("Advisor disabled. Reply with one short confirmation.");
        return;
      }
      const ref = parseModelRef(arg.model);
      if (!ref) {
        await reply(`Invalid model "${arg.model}". Use provider/model[#variant], e.g. /advisor anthropic/claude-opus-4-6#high, or /advisor off.`);
        return;
      }
      const all = toArray(await host.listModels());
      const found = all.find((m) => m.providerID === ref.providerID && (m.id === ref.id || m.modelID === ref.id));
      if (!found) {
        await reply(`No model ${ref.providerID}/${ref.id} found. Check the model name and try again.`);
        return;
      }
      if (ref.variant && Array.isArray(found.variants) && found.variants.length > 0 && !found.variants.some((v) => v?.id === ref.variant)) {
        const valid = found.variants.map((v) => v?.id).filter(Boolean).join(", ");
        await reply(`Variant "${ref.variant}" not supported by ${ref.providerID}/${ref.id}. Valid: ${valid}.`);
        return;
      }
      const canonical = `${ref.providerID}/${found.id ?? ref.id}${ref.variant ? `#${ref.variant}` : ""}`;
      await host.save({ ...config, model: canonical });
      await reply(`Advisor reviewer model set to ${canonical}. Reply with one short confirmation.`);
    }
  };
}

// src/index.ts
var ADVISOR_TOOL = "advisor";
var SHORT_DESCRIPTION = "Escalate to a stronger reviewer model for guidance. Takes NO parameters — your entire conversation is forwarded automatically. Call BEFORE substantive work, when stuck, or before declaring done.";
function toArray2(models) {
  if (Array.isArray(models))
    return models;
  const obj = models ?? {};
  if (Array.isArray(obj.data))
    return obj.data;
  if (Array.isArray(obj.models))
    return obj.models;
  return Object.values(obj);
}
function errText(e) {
  return e instanceof Error ? e.message : String(e);
}
var src_default = Plugin.define({
  id: "oc-advisor",
  async setup(ctx) {
    let current = applyOptions(await resolveConfig(ctx.storage), ctx.options);
    const uses = new Map;
    const executorKey = (model) => `${model?.providerID}/${model?.id}`;
    const advisorActive = (model) => current.model !== undefined && !isDisabledModel(executorKey(model), current.disabledForModels);
    await ctx.tool.transform((editor) => {
      editor.add({
        name: ADVISOR_TOOL,
        description: SHORT_DESCRIPTION,
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async (_input, context) => {
          const sessionID = context.sessionID;
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
            const text = await runAdvisorCall({
              readContext: async (id) => ctx.session.context({ sessionID: id }),
              listToolNames: async () => toArray2(await ctx.tool.list()).map((t) => t.id ?? t.name).filter((n) => typeof n === "string"),
              generateText: async (model, prompt) => {
                const result = await ctx.generate.text({
                  model: {
                    providerID: model.providerID,
                    id: model.id,
                    ...model.variant ? { variant: model.variant } : {}
                  },
                  prompt
                });
                return result?.text ?? "";
              }
            }, { sessionID, callId: context.id, ref });
            return { content: text };
          } catch (e) {
            return { content: e instanceof AdvisorError ? e.message : `Advisor call failed: ${errText(e)}` };
          }
        }
      });
    });
    await ctx.command.transform((editor) => {
      editor.add(createAdvisorCommand({
        load: async () => current,
        save: async (c) => {
          current = c;
          await saveConfig(ctx.storage, c);
        },
        listModels: async () => ctx.model.list(),
        prompt: async (input) => ctx.session.prompt(input)
      }));
    });
    await ctx.session.hook("prompt", async (event) => {
      uses.set(event.sessionID, 0);
    });
    await ctx.session.hook("context", async (event) => {
      try {
        if (!advisorActive(event.model)) {
          if (event.tools)
            delete event.tools[ADVISOR_TOOL];
          return;
        }
        event.system.push({ type: "text", text: EXECUTOR_GUIDANCE });
      } catch {}
    });
    return () => {
      uses.clear();
    };
  }
});
export {
  src_default as default
};
