// src/push.ts
var DEFAULT_PUSH = { mode: "off", minSeverity: "concern", cooldownTurns: 3, maxPerPrompt: 2 };
var ADVISOR_NOTE_PREFIX = "Advisor note";
var RECENT_LIMIT = 5;
var RANK = { silent: -1, nit: 0, concern: 1, blocker: 2 };
var PUSH_INSTRUCTIONS = `You are reviewing the executor's latest completed run, not answering a question. Reply with exactly SILENT when nothing material needs the executor's attention. Otherwise start your reply with one tag, [nit], [concern] or [blocker], then the advice in at most three sentences. Use [blocker] only when continuing would clearly waste work or produce broken output. Never repeat advice listed under "already raised".`;
function parseReview(text) {
  const trimmed = text.trim();
  if (trimmed === "" || /^silent\b/i.test(trimmed))
    return { severity: "silent", body: "" };
  const tag = /^\[(nit|concern|blocker)\]\s*/i.exec(trimmed);
  if (tag)
    return { severity: tag[1].toLowerCase(), body: trimmed.slice(tag[0].length).trim() };
  return { severity: "nit", body: trimmed };
}
function shouldPush(severity, minSeverity) {
  return RANK[severity] >= RANK[minSeverity];
}
function newPushState() {
  return { cooldown: 0, pushesThisPrompt: 0, recent: [], raw: [] };
}
function canPush(state, cfg) {
  return state.cooldown === 0 && state.pushesThisPrompt < cfg.maxPerPrompt;
}
function skipTurn(state) {
  if (state.cooldown > 0)
    state.cooldown -= 1;
}
function recordPush(state, body, cfg) {
  state.pushesThisPrompt += 1;
  state.cooldown = cfg.cooldownTurns;
  state.recent = [normalizeNote(body), ...state.recent].slice(0, RECENT_LIMIT);
  state.raw = [body, ...state.raw].slice(0, RECENT_LIMIT);
}
function resetPrompt(state) {
  state.pushesThisPrompt = 0;
}
function isRepeat(state, body) {
  return state.recent.includes(normalizeNote(body));
}
function normalizeNote(text) {
  return text.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function pushNoteText(severity, body) {
  return `${ADVISOR_NOTE_PREFIX} (${severity}): ${body}`;
}
function isAdvisorNote(text) {
  return text.startsWith(`${ADVISOR_NOTE_PREFIX} (`);
}

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
var EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
function effortRank(effort) {
  return effort === undefined ? -1 : EFFORT_LEVELS.indexOf(effort);
}
function isDisabledModel(executorRef, disabledForModels, effort) {
  const key = canonicalKey(executorRef);
  return disabledForModels.some((entry) => {
    const model = typeof entry === "string" ? entry : entry.model;
    if (canonicalKey(model) !== key)
      return false;
    if (typeof entry === "string" || entry.minEffort === undefined)
      return true;
    const rank = effortRank(effort);
    return rank >= 0 && rank >= effortRank(entry.minEffort);
  });
}
function shouldGuide(config, executorRef, effort) {
  return config.model !== undefined && !isDisabledModel(executorRef, config.disabledForModels, effort);
}
function maxUsesExceeded(used, maxUses) {
  if (maxUses === undefined || maxUses <= 0)
    return false;
  return used >= maxUses;
}
var PUSH_USAGE = "Usage: /advisor push [off | agent-end | min nit|concern|blocker | cooldown N | max N]";
function parseAdvisorArgs(text) {
  const rest = text.replace(/^\s*\/advisor\b\s*/, "").trim();
  if (!rest)
    return { action: "show" };
  if (rest.toLowerCase() === "off")
    return { action: "off" };
  const [head, ...args] = rest.split(/\s+/);
  if (head.toLowerCase() === "push")
    return parsePushArgs(args);
  if (head.toLowerCase() === "notes") {
    const value = args[0]?.toLowerCase();
    if (value === "on" || value === "off")
      return { action: "notes", on: value === "on" };
    return { action: "invalid", message: "Usage: /advisor notes on|off" };
  }
  return { action: "set", model: rest };
}
function parsePushArgs(args) {
  if (args.length === 0)
    return { action: "push-show" };
  const [key, value] = [args[0].toLowerCase(), args[1]];
  if (args.length === 1 && (key === "off" || key === "agent-end")) {
    return { action: "push-set", patch: { mode: key } };
  }
  if (args.length === 2 && key === "min" && (value === "nit" || value === "concern" || value === "blocker")) {
    return { action: "push-set", patch: { minSeverity: value } };
  }
  if (args.length === 2 && (key === "cooldown" || key === "max") && /^\d+$/.test(value)) {
    const n = Number(value);
    return { action: "push-set", patch: key === "cooldown" ? { cooldownTurns: n } : { maxPerPrompt: n } };
  }
  return { action: "invalid", message: PUSH_USAGE };
}

class AdvisorError extends Error {
}
function toRequestSnapshot(system, tools) {
  return {
    system: system.map((part) => part.text ?? "").filter(Boolean).join(`

`),
    tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, input: t.input }))
  };
}
async function contextLimitOf(deps, ref) {
  try {
    return await deps.contextLimit?.(ref);
  } catch {
    return;
  }
}
async function projectNotesOf(deps) {
  try {
    return (await deps.readProjectNotes?.())?.trim() || undefined;
  } catch {
    return;
  }
}
async function runAdvisorCall(deps, input) {
  const messages = await deps.readContext(input.sessionID).catch((e) => {
    throw new AdvisorError(`could not read session context: ${e instanceof Error ? e.message : String(e)}`);
  });
  const snapshot = deps.readRequest?.(input.sessionID);
  const tools = snapshot?.tools ?? (await deps.listToolNames().catch(() => ["advisor"])).map((name) => ({ name }));
  const branch = buildAdvisorPrompt(normalizeBranch(messages), {
    inflightCallId: input.callId,
    tools,
    system: snapshot?.system,
    budgetChars: reviewBudgetChars(await contextLimitOf(deps, input.ref))
  });
  const notes = await projectNotesOf(deps);
  const system = notes ? `${ADVISOR_SYSTEM_PROMPT}

## Project advisor notes
${notes}` : ADVISOR_SYSTEM_PROMPT;
  const push = input.push ? `

${PUSH_INSTRUCTIONS}

"already raised" (do not repeat):
${input.push.alreadyRaised.map((n) => `- ${n}`).join(`
`) || "- (none)"}` : "";
  const text = await deps.generateText(input.ref, `${system}

${branch}${push}`, { signal: input.signal }).catch((e) => {
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
    const content = Array.isArray(m.content) ? m.content.map((p) => ({ type: p.type, text: p.text, id: p.id, name: p.name, ...toolIO(p) })) : undefined;
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
function textParts(content) {
  if (!Array.isArray(content))
    return [];
  const out = [];
  for (const c of content) {
    if (c && c.type === "text" && typeof c.text === "string" && c.text)
      out.push(c.text);
  }
  return out;
}
function toolIO(part) {
  const state = part?.state;
  if (!state || typeof state !== "object")
    return {};
  const out = {};
  if (state.input !== undefined) {
    try {
      out.input = JSON.stringify(state.input);
    } catch {
      out.input = String(state.input);
    }
  }
  if (state.status === "completed") {
    const texts = textParts(state.content);
    if (texts.length > 0)
      out.result = texts.join(`
`);
  } else if (state.status === "error") {
    const message = state.error && typeof state.error.message === "string" ? state.error.message : "unknown error";
    const texts = textParts(state.content);
    out.result = texts.length > 0 ? `${message}
${texts.join(`
`)}` : message;
  }
  return out;
}
function renderMessage(msg, inflightCallId, cap) {
  if (msg.type === "user" || msg.type === "synthetic") {
    if (!msg.text)
      return null;
    if (msg.type === "synthetic" && isAdvisorNote(msg.text))
      return null;
    return `## ${msg.type}:
${msg.text}`;
  }
  const parts = (msg.content ?? []).filter((p) => inflightCallId === undefined || p.id !== inflightCallId);
  const who = msg.agent ?? (msg.model ? `${msg.model.providerID}/${msg.model.id}` : "assistant");
  const lines = [];
  for (const p of parts) {
    if (typeof p.text === "string" && p.text)
      lines.push(p.text);
    else if (p.name) {
      lines.push(`tool call ${p.name}${p.id ? ` (${p.id})` : ""}${p.input ? ` input: ${p.input}` : ""}`);
      if (p.result)
        lines.push(`result:
${elide(p.result, cap)}`);
    }
  }
  if (msg.text && lines.length === 0)
    lines.push(msg.text);
  if (lines.length === 0)
    return null;
  return `## assistant (${who}):
${lines.join(`
`)}`;
}
var RESULT_CAP_CHARS = 8000;
var REVIEW_BUDGET_CHARS = 400000;
var REVIEW_SHARE = 0.6;
var CHARS_PER_TOKEN = 3.5;
function reviewBudgetChars(contextTokens) {
  if (!contextTokens || contextTokens <= 0)
    return REVIEW_BUDGET_CHARS;
  return Math.floor(contextTokens * REVIEW_SHARE * CHARS_PER_TOKEN);
}
function elide(text, cap) {
  if (text.length <= cap)
    return text;
  const head = Math.floor(cap * 0.75);
  return `${text.slice(0, head)}
[elided ${text.length - cap} chars]
${text.slice(-(cap - head))}`;
}
function renderTools(tools) {
  const sorted = [...tools].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const lines = sorted.map((t) => t.description === undefined && t.input === undefined ? `- ${t.name}` : `- ${t.name}: ${t.description ?? ""}${t.input === undefined ? "" : `
  input: ${JSON.stringify(t.input)}`}`);
  return `## tools:
${lines.join(`
`)}`;
}
function renderBlocks(messages, inflightCallId, cap) {
  const blocks = [];
  let pin = -1;
  let lastWasUser = false;
  for (const msg of messages) {
    const rendered = renderMessage(msg, inflightCallId, cap);
    if (!rendered) {
      lastWasUser = false;
      continue;
    }
    if (pin < 0 && msg.type === "user")
      pin = blocks.length;
    blocks.push(rendered);
    lastWasUser = msg.type === "user";
  }
  if (!lastWasUser)
    blocks.push(`## user:
Please advise on the executor's situation above.`);
  return { blocks, pin: Math.max(pin, 0) };
}
function fitTranscript(blocks, pin, room) {
  const last = blocks.length - 1;
  const keep = new Set([pin, last]);
  let used = [...keep].reduce((sum, i) => sum + blocks[i].length, 0);
  for (let i = last - 1;i >= 0; i--) {
    if (i === pin)
      continue;
    if (used + blocks[i].length > room)
      break;
    used += blocks[i].length;
    keep.add(i);
  }
  const out = [];
  let omitted = 0;
  blocks.forEach((block, i) => {
    if (!keep.has(i)) {
      omitted += 1;
      return;
    }
    if (omitted > 0)
      out.push(`## (${omitted} earlier messages omitted to fit the budget)`);
    omitted = 0;
    out.push(block);
  });
  return out;
}
function buildAdvisorPrompt(messages, opts) {
  const head = [
    opts.system ? `## system (executor's system prompt, addressed to the executor, not you):
${opts.system}` : "",
    renderTools(opts.tools)
  ].filter(Boolean);
  const room = (opts.budgetChars ?? REVIEW_BUDGET_CHARS) - head.join(`

`).length;
  const total = (blocks) => blocks.reduce((sum, b) => sum + b.length, 0);
  const full = renderBlocks(messages, opts.inflightCallId, Infinity);
  const transcript = total(full.blocks) <= room ? full : renderBlocks(messages, opts.inflightCallId, RESULT_CAP_CHARS);
  return [...head, ...fitTranscript(transcript.blocks, transcript.pin, room)].join(`

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

If you've already retrieved data pointing one way and the advisor points another: don't silently switch. Surface the conflict in one more advisor call — "I found X, you suggest Y, which constraint breaks the tie?" The advisor saw your evidence but may have underweighted it; a reconcile call is cheaper than committing to the wrong branch.

After each advisor result, put the advisor's key guidance into your next visible reply to the user before continuing — quote or paraphrase the plan, correction, or stop signal. The user often cannot see collapsed tool results; do not keep the advisor's words only in silent tool context.`;
var ADVISOR_SYSTEM_PROMPT = `You are an advisor model in an advisor-strategy pattern. An executor model is running a task end-to-end — calling tools, reading results, iterating toward a solution. When the executor hits a decision it cannot reasonably solve alone, it consults you for guidance. The executor's full tool inventory is prepended before the conversation so you can judge tool-choice correctness.

You read the shared conversation context and return ONE of:
- a plan (concrete next steps the executor should take),
- a correction (the executor is going down a wrong path — redirect it),
- a stop signal (the executor should halt and escalate to the user).

You NEVER call tools. You NEVER produce user-facing output. Be concise, directive, and grounded in the shared context. Name files, functions, and line numbers where possible. No preamble, no apologies, no meta-commentary about being an advisor — just the guidance the executor needs. Stay silent when the executor is on track. Do not ask it to clarify the user's request or second-guess intent it has understood, and do not repeat advice it already has or restate errors it can see. Cite transcript evidence for each concrete claim.`;

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
function describePush(push, projectNotes) {
  return [
    `Push mode: ${push.mode}`,
    `(min severity: ${push.minSeverity}, cooldown: ${push.cooldownTurns} agent-end runs,`,
    `max per prompt: ${push.maxPerPrompt}, project notes: ${projectNotes ? "on" : "off"}).`,
    "See docs/push-mode.md for what each setting does."
  ].join(" ");
}
function createAdvisorCommand(host) {
  return {
    name: "advisor",
    description: "Advisor reviewer: /advisor provider/model[#variant] | off | push [off|agent-end|min|cooldown|max] | notes on|off",
    execute: async ({ sessionID, prompt, delivery }) => {
      const reply = (text) => host.prompt({ sessionID, text, delivery });
      const config = await host.load();
      const arg = parseAdvisorArgs(prompt?.text ?? "");
      if (arg.action === "invalid") {
        await reply(arg.message);
        return;
      }
      if (arg.action === "push-show") {
        await reply(describePush(config.push, config.projectNotes));
        return;
      }
      if (arg.action === "push-set") {
        const push = { ...config.push, ...arg.patch };
        await host.save({ ...config, push });
        const summary = arg.patch.mode !== undefined ? `Push mode set to ${push.mode}.` : "Push setting updated.";
        await reply(`${summary} ${describePush(push, config.projectNotes)}`);
        return;
      }
      if (arg.action === "notes") {
        await host.save({ ...config, projectNotes: arg.on });
        await reply(`Project notes ${arg.on ? "on" : "off"}: reads .opencode/advisor.md in the project when enabled.`);
        return;
      }
      if (arg.action === "show") {
        await reply(config.model ? `Advisor: ${config.model}${config.maxUses > 0 ? ` (max ${config.maxUses} calls per request)` : ""}. Push mode: ${config.push.mode}.` : "Advisor: off. Set one with /advisor provider/model[#variant], e.g. /advisor anthropic/claude-opus-4-6#high");
        return;
      }
      if (arg.action === "off") {
        await host.save({ ...config, model: undefined });
        await reply("Advisor disabled (a static options.model in opencode.json will re-enable it on restart). Reply with one short confirmation.");
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

// src/config.ts
function isDisabledEntry(entry) {
  if (typeof entry === "string")
    return parseModelRef(entry) !== null;
  if (!entry || typeof entry !== "object")
    return false;
  const { model, minEffort } = entry;
  return typeof model === "string" && parseModelRef(model) !== null && (minEffort === undefined || EFFORT_LEVELS.includes(minEffort));
}
var DEFAULT_CONFIG = {
  model: undefined,
  disabledForModels: [],
  maxUses: 0,
  push: DEFAULT_PUSH,
  projectNotes: false,
  mainAgentOnly: false
};
var PUSH_MODES = ["off", "agent-end"];
var SEVERITIES = ["nit", "concern", "blocker"];
function sanitizePush(raw) {
  if (!raw || typeof raw !== "object")
    return {};
  const r = raw;
  const out = {};
  if (PUSH_MODES.includes(r.mode))
    out.mode = r.mode;
  if (SEVERITIES.includes(r.minSeverity)) {
    out.minSeverity = r.minSeverity;
  }
  if (isNonNegativeInt(r.cooldownTurns))
    out.cooldownTurns = r.cooldownTurns;
  if (isNonNegativeInt(r.maxPerPrompt))
    out.maxPerPrompt = r.maxPerPrompt;
  return out;
}
function isNonNegativeInt(v) {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}
function sanitizeOptions(raw) {
  const out = { ...DEFAULT_CONFIG, disabledForModels: [], push: { ...DEFAULT_PUSH } };
  if (!raw || typeof raw !== "object")
    return out;
  if (typeof raw.model === "string" && parseModelRef(raw.model))
    out.model = raw.model.trim();
  if (Array.isArray(raw.disabledForModels)) {
    out.disabledForModels = raw.disabledForModels.filter(isDisabledEntry);
  }
  if (typeof raw.maxUses === "number" && Number.isFinite(raw.maxUses) && raw.maxUses > 0) {
    out.maxUses = Math.floor(raw.maxUses);
  }
  out.push = { ...DEFAULT_PUSH, ...sanitizePush(raw.push) };
  out.projectNotes = raw.projectNotes === true;
  out.mainAgentOnly = raw.mainAgentOnly === true;
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
  out.push = { ...base.push, ...sanitizePush(raw?.push) };
  if (raw && typeof raw === "object" && raw.projectNotes !== undefined)
    out.projectNotes = opts.projectNotes;
  out.mainAgentOnly = opts.mainAgentOnly;
  return out;
}
async function saveConfig(storage, config) {
  await storage.set("config", config);
}
async function readConfig(storage, options) {
  return applyOptions(await resolveConfig(storage), options);
}

// src/notes.ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
var NOTES_MAX_CHARS = 8000;
var NOTES_FILE = join(".opencode", "advisor.md");
async function readProjectNotes(directory) {
  try {
    return (await readFile(join(directory, NOTES_FILE), "utf8")).slice(0, NOTES_MAX_CHARS);
  } catch {
    return;
  }
}

// src/tool.ts
var SHORT_DESCRIPTION = "Escalate to a stronger reviewer model for guidance. Takes NO parameters — your entire conversation is forwarded automatically. Call BEFORE substantive work, when stuck, or before declaring done.";
function createAdvisorTool(host) {
  const uses = new Map;
  return {
    review(sessionID, ref, alreadyRaised) {
      return runAdvisorCall(host, { sessionID, ref, push: { alreadyRaised } });
    },
    definition: {
      name: "advisor",
      description: SHORT_DESCRIPTION,
      input: { type: "object", properties: {}, additionalProperties: false },
      options: { codemode: false },
      execute: async (_input, context) => {
        const config = await host.loadConfig();
        if (!config.model) {
          return { content: "No advisor model is configured. The user can enable one with the /advisor command." };
        }
        const ref = parseModelRef(config.model);
        if (!ref) {
          return { content: `Advisor model is misconfigured: ${config.model}. Fix it with /advisor.` };
        }
        const used = uses.get(context.sessionID) ?? 0;
        if (maxUsesExceeded(used, config.maxUses)) {
          return { content: "Advisor call limit reached (max_uses_exceeded). Continuing without further advice." };
        }
        uses.set(context.sessionID, used + 1);
        try {
          const text = await runAdvisorCall(host, { sessionID: context.sessionID, callId: context.id, ref, signal: context.signal });
          return { content: text };
        } catch (e) {
          return { content: e instanceof AdvisorError ? e.message : `Advisor call failed: ${e instanceof Error ? e.message : String(e)}` };
        }
      }
    },
    resetUses(sessionID) {
      uses.set(sessionID, 0);
    },
    forget(sessionID) {
      uses.delete(sessionID);
    }
  };
}

// src/index.ts
var src_default = {
  id: "oc-advisor",
  async setup(ctx) {
    const read = () => readConfig(ctx.storage, ctx.options);
    const executorKey = (model) => `${model?.providerID}/${model?.id}`;
    const snapshots = new Map;
    const executors = new Map;
    const pushStates = new Map;
    const advisor = createAdvisorTool({
      loadConfig: read,
      readContext: async (sessionID) => ctx.session.context({ sessionID }),
      readRequest: (sessionID) => snapshots.get(sessionID),
      contextLimit: async (model) => toArray2(await ctx.model.list()).find((m) => m.providerID === model.providerID && m.id === model.id)?.limit?.context,
      readProjectNotes: async () => {
        const config = await read();
        return config.projectNotes ? readProjectNotes(ctx.location.directory) : undefined;
      },
      listToolNames: async () => toArray2(await ctx.tool.list()).map((t) => t.id ?? t.name).filter((n) => typeof n === "string"),
      generateText: async (model, prompt, opts) => {
        const result = await ctx.generate.text({
          model: {
            providerID: model.providerID,
            id: model.id,
            ...model.variant ? { variant: model.variant } : {}
          },
          prompt
        }, opts?.signal ? { signal: opts.signal } : undefined);
        return result?.text ?? "";
      }
    });
    await ctx.tool.transform((editor) => {
      editor.add(advisor.definition);
    });
    await ctx.command.transform((editor) => {
      editor.add(createAdvisorCommand({
        load: read,
        save: async (c) => saveConfig(ctx.storage, c),
        listModels: async () => ctx.model.list(),
        prompt: async (input) => ctx.session.prompt(input)
      }));
    });
    await ctx.session.hook("prompt", async (event) => {
      advisor.resetUses(event.sessionID);
      const state = pushStates.get(event.sessionID);
      if (state)
        resetPrompt(state);
    });
    await ctx.session.hook("context", async (event) => {
      try {
        const e = event;
        const config = await read();
        const child = config.mainAgentOnly ? (await ctx.session.get({ sessionID: e.sessionID }))?.parentID !== undefined : false;
        executors.set(e.sessionID, { key: executorKey(e.model), effort: e.model?.variant, child });
        if (child || !shouldGuide(config, executorKey(e.model), e.model?.variant)) {
          if (e.tools)
            delete e.tools.advisor;
          return;
        }
        e.system.push({ type: "text", text: EXECUTOR_GUIDANCE });
        snapshots.set(e.sessionID, toRequestSnapshot(e.system, e.tools));
      } catch {}
    });
    const afterRun = async (sessionID) => {
      const config = await read();
      if (config.push.mode === "off" || config.model === undefined)
        return;
      const executor = executors.get(sessionID);
      if (!executor || executor.child || !shouldGuide(config, executor.key, executor.effort))
        return;
      const ref = parseModelRef(config.model);
      if (!ref)
        return;
      const state = pushStates.get(sessionID) ?? newPushState();
      pushStates.set(sessionID, state);
      if (state.cooldown > 0) {
        skipTurn(state);
        return;
      }
      if (!canPush(state, config.push))
        return;
      const { severity, body } = parseReview(await advisor.review(sessionID, ref, state.raw));
      if (!shouldPush(severity, config.push.minSeverity) || isRepeat(state, body))
        return;
      recordPush(state, body, config.push);
      await ctx.session.synthetic({
        sessionID,
        text: pushNoteText(severity, body),
        delivery: "queue",
        resume: false
      });
    };
    const controller = new AbortController;
    (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const e = event;
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
      } catch {}
    })();
    return () => controller.abort();
  }
};
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
export {
  src_default as default
};
