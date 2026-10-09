// Pure advisor-strategy helpers: parsing, matching, prompt building.
// No opencode APIs here so every function is unit-testable without mocks.

export interface ModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

/** Parse "provider/model#variant" (variant optional, model may contain slashes). */
export function parseModelRef(raw: string): ModelRef | null {
  const text = raw.trim();
  if (!text) return null;
  const hash = text.indexOf("#");
  const main = (hash === -1 ? text : text.slice(0, hash)).trim();
  const variant = hash === -1 ? undefined : text.slice(hash + 1).trim() || undefined;
  const slash = main.indexOf("/");
  if (slash <= 0) return null;
  const providerID = main.slice(0, slash).trim();
  const id = main.slice(slash + 1).trim();
  if (!providerID || !id) return null;
  return variant === undefined ? { providerID, id } : { providerID, id, variant };
}

function canonicalKey(ref: string): string {
  const parsed = parseModelRef(ref);
  if (!parsed) return ref.trim();
  return `${parsed.providerID}/${parsed.id}`;
}

export const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** A blocked executor model, optionally only at or above a reasoning effort. */
export type DisabledEntry = string | { model: string; minEffort?: string };

function effortRank(effort: string | undefined): number {
  return effort === undefined ? -1 : EFFORT_LEVELS.indexOf(effort as (typeof EFFORT_LEVELS)[number]);
}

/** Exact provider/model match (variant ignored). A minEffort entry blocks only at or above that effort. */
export function isDisabledModel(executorRef: string, disabledForModels: readonly DisabledEntry[], effort?: string): boolean {
  const key = canonicalKey(executorRef);
  return disabledForModels.some((entry) => {
    const model = typeof entry === "string" ? entry : entry.model;
    if (canonicalKey(model) !== key) return false;
    if (typeof entry === "string" || entry.minEffort === undefined) return true;
    const rank = effortRank(effort);
    return rank >= 0 && rank >= effortRank(entry.minEffort);
  });
}

/** True when the advisor should be offered: a model is set and the executor isn't blocklisted. */
export function shouldGuide(
  config: { model?: string; disabledForModels: readonly DisabledEntry[] },
  executorRef: string,
  effort?: string,
): boolean {
  return config.model !== undefined && !isDisabledModel(executorRef, config.disabledForModels, effort);
}

/** Absent or zero maxUses means unlimited. */
export function maxUsesExceeded(used: number, maxUses: number | undefined): boolean {
  if (maxUses === undefined || maxUses <= 0) return false;
  return used >= maxUses;
}

export type AdvisorArg = { action: "show" } | { action: "off" } | { action: "set"; model: string };

/** Parse "/advisor [provider/model[#variant] | off]". */
export function parseAdvisorArgs(text: string): AdvisorArg {
  const rest = text.replace(/^\s*\/advisor\b\s*/, "").trim();
  if (!rest) return { action: "show" };
  if (rest.toLowerCase() === "off") return { action: "off" };
  return { action: "set", model: rest };
}

export interface BranchPart {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: string;
  result?: string;
}

export interface BranchMessage {
  type: string;
  text?: string;
  agent?: string;
  model?: { providerID?: string; id?: string };
  content?: BranchPart[];
}

export class AdvisorError extends Error {}

export interface ToolSpec {
  name: string;
  description?: string;
  input?: unknown;
}

/** The executor's system prompt and tool definitions, as sent on its last model call. */
export interface RequestSnapshot {
  system: string;
  tools: ToolSpec[];
}

export function toRequestSnapshot(
  system: readonly { type?: string; text?: string }[],
  tools: Record<string, { description?: string; input?: unknown }>,
): RequestSnapshot {
  return {
    system: system.map((part) => part.text ?? "").filter(Boolean).join("\n\n"),
    tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, input: t.input })),
  };
}

export interface AdvisorCallDeps {
  readContext(sessionID: string): Promise<unknown>;
  listToolNames(): Promise<string[]>;
  generateText(model: ModelRef, prompt: string, opts?: { signal?: AbortSignal }): Promise<string>;
  readRequest?(sessionID: string): RequestSnapshot | undefined;
  contextLimit?(model: ModelRef): Promise<number | undefined>;
}

async function contextLimitOf(deps: AdvisorCallDeps, ref: ModelRef): Promise<number | undefined> {
  try {
    return await deps.contextLimit?.(ref);
  } catch {
    return undefined;
  }
}

/** Build the reviewer prompt and run one side-call. Throws AdvisorError with user-facing text on failure. */
export async function runAdvisorCall(
  deps: AdvisorCallDeps,
  input: { sessionID: string; callId: string; ref: ModelRef; signal?: AbortSignal },
): Promise<string> {
  const messages = await deps.readContext(input.sessionID).catch((e: unknown) => {
    throw new AdvisorError(`could not read session context: ${e instanceof Error ? e.message : String(e)}`);
  });
  const snapshot = deps.readRequest?.(input.sessionID);
  const tools = snapshot?.tools ?? (await deps.listToolNames().catch(() => ["advisor"])).map((name) => ({ name }));
  const branch = buildAdvisorPrompt(normalizeBranch(messages), {
    inflightCallId: input.callId,
    tools,
    system: snapshot?.system,
    budgetChars: reviewBudgetChars(await contextLimitOf(deps, input.ref)),
  });
  const text = await deps
    .generateText(input.ref, `${ADVISOR_SYSTEM_PROMPT}\n\n${branch}`, { signal: input.signal })
    .catch((e: unknown) => {
      throw new AdvisorError(`Advisor call failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  if (!text.trim()) throw new AdvisorError("Advisor returned no text content.");
  return text.trim();
}

/** Normalize raw session messages into BranchMessage shapes. */
export function normalizeBranch(messages: unknown): BranchMessage[] {
  if (!Array.isArray(messages)) return [];
  return (messages as any[]).map((m) => {
    const content = Array.isArray(m.content)
      ? (m.content as any[]).map(
          (p): BranchPart => ({ type: p.type, text: p.text, id: p.id, name: p.name, ...toolIO(p) }),
        )
      : undefined;
    const out: BranchMessage = { type: String(m.type ?? "unknown") };
    if (typeof m.text === "string") out.text = m.text;
    if (typeof m.agent === "string") out.agent = m.agent;
    if (m.model && typeof m.model === "object") out.model = { providerID: m.model.providerID, id: m.model.id };
    if (content) out.content = content;
    return out;
  });
}

function textParts(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const c of content as any[]) {
    if (c && c.type === "text" && typeof c.text === "string" && c.text) out.push(c.text);
  }
  return out;
}

function toolIO(part: any): { input?: string; result?: string } {
  const state = part?.state;
  if (!state || typeof state !== "object") return {};
  const out: { input?: string; result?: string } = {};
  if (state.input !== undefined) {
    try {
      out.input = JSON.stringify(state.input);
    } catch {
      out.input = String(state.input);
    }
  }
  if (state.status === "completed") {
    const texts = textParts(state.content);
    if (texts.length > 0) out.result = texts.join("\n");
  } else if (state.status === "error") {
    const message = state.error && typeof state.error.message === "string" ? state.error.message : "unknown error";
    const texts = textParts(state.content);
    out.result = texts.length > 0 ? `${message}\n${texts.join("\n")}` : message;
  }
  return out;
}

function renderMessage(msg: BranchMessage, inflightCallId: string | undefined, cap: number): string | null {
  if (msg.type === "user" || msg.type === "synthetic") {
    if (!msg.text) return null;
    return `## ${msg.type}:\n${msg.text}`;
  }
  const parts = (msg.content ?? []).filter((p) => inflightCallId === undefined || p.id !== inflightCallId);
  const who = msg.agent ?? (msg.model ? `${msg.model.providerID}/${msg.model.id}` : "assistant");
  const lines: string[] = [];
  for (const p of parts) {
    if (typeof p.text === "string" && p.text) lines.push(p.text);
    else if (p.name) {
      lines.push(`tool call ${p.name}${p.id ? ` (${p.id})` : ""}${p.input ? ` input: ${p.input}` : ""}`);
      if (p.result) lines.push(`result:\n${elide(p.result, cap)}`);
    }
  }
  if (msg.text && lines.length === 0) lines.push(msg.text);
  if (lines.length === 0) return null;
  return `## assistant (${who}):\n${lines.join("\n")}`;
}

const RESULT_CAP_CHARS = 8_000;
// ponytail: fallback budget when the reviewer's context window is unknown.
export const REVIEW_BUDGET_CHARS = 400_000;
const REVIEW_SHARE = 0.6; // share of the reviewer's window the transcript may use
const CHARS_PER_TOKEN = 3.5; // rough estimate for code and prose

export function reviewBudgetChars(contextTokens?: number): number {
  if (!contextTokens || contextTokens <= 0) return REVIEW_BUDGET_CHARS;
  return Math.floor(contextTokens * REVIEW_SHARE * CHARS_PER_TOKEN);
}

/** Keep the head and tail of an oversized tool result. */
function elide(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const head = Math.floor(cap * 0.75);
  return `${text.slice(0, head)}\n[elided ${text.length - cap} chars]\n${text.slice(-(cap - head))}`;
}

function renderTools(tools: readonly ToolSpec[]): string {
  const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const lines = sorted.map((t) =>
    t.description === undefined && t.input === undefined
      ? `- ${t.name}`
      : `- ${t.name}: ${t.description ?? ""}${t.input === undefined ? "" : `\n  input: ${JSON.stringify(t.input)}`}`,
  );
  return `## tools:\n${lines.join("\n")}`;
}

function renderBlocks(
  messages: readonly BranchMessage[],
  inflightCallId: string | undefined,
  cap: number,
): { blocks: string[]; pin: number } {
  const blocks: string[] = [];
  let pin = -1;
  let lastWasUser = false;
  for (const msg of messages) {
    const rendered = renderMessage(msg, inflightCallId, cap);
    if (!rendered) {
      lastWasUser = false;
      continue;
    }
    if (pin < 0 && msg.type === "user") pin = blocks.length;
    blocks.push(rendered);
    lastWasUser = msg.type === "user";
  }
  if (!lastWasUser) blocks.push("## user:\nPlease advise on the executor's situation above.");
  return { blocks, pin: Math.max(pin, 0) };
}

/** Keep the pinned task and the newest block, then as many newer-to-older blocks as fit. */
function fitTranscript(blocks: readonly string[], pin: number, room: number): string[] {
  const last = blocks.length - 1;
  const keep = new Set([pin, last]);
  let used = [...keep].reduce((sum, i) => sum + blocks[i].length, 0);
  for (let i = last - 1; i >= 0; i--) {
    if (i === pin) continue;
    if (used + blocks[i].length > room) break;
    used += blocks[i].length;
    keep.add(i);
  }
  const out: string[] = [];
  let omitted = 0;
  blocks.forEach((block, i) => {
    if (!keep.has(i)) {
      omitted += 1;
      return;
    }
    if (omitted > 0) out.push(`## (${omitted} earlier messages omitted to fit the budget)`);
    omitted = 0;
    out.push(block);
  });
  return out;
}

/**
 * Serialize the executor branch for the reviewer: system prompt and tool
 * definitions first, in-flight advisor call stripped, guaranteed user-role tail.
 */
export function buildAdvisorPrompt(
  messages: readonly BranchMessage[],
  opts: { inflightCallId?: string; tools: readonly ToolSpec[]; system?: string; budgetChars?: number },
): string {
  const head = [
    opts.system ? `## system (executor's system prompt, addressed to the executor, not you):\n${opts.system}` : "",
    renderTools(opts.tools),
  ].filter(Boolean);
  const room = (opts.budgetChars ?? REVIEW_BUDGET_CHARS) - head.join("\n\n").length;
  const total = (blocks: string[]) => blocks.reduce((sum, b) => sum + b.length, 0);
  const full = renderBlocks(messages, opts.inflightCallId, Infinity);
  const transcript = total(full.blocks) <= room ? full : renderBlocks(messages, opts.inflightCallId, RESULT_CAP_CHARS);
  return [...head, ...fitTranscript(transcript.blocks, transcript.pin, room)].join("\n\n");
}

// Executor guidance injected into the agent loop. Source: Claude Code's advisor
// tool instructions (community dump of its system prompt), plus the
// visible-restatement rule from @juicesharp/rpiv-advisor.
export const EXECUTOR_GUIDANCE = `You have access to an \`advisor\` tool backed by a stronger reviewer model. It takes NO parameters — when you call advisor(), your entire conversation history is automatically forwarded. They see the task, every tool call you've made, every result you've seen.

Call advisor BEFORE substantive work — before writing, before committing to an interpretation, before building on an assumption. If the task requires orientation first (finding files, fetching a source, seeing what's there), do that, then call advisor. Orientation is not substantive work. Writing, editing, and declaring an answer are.

Also call advisor:
- When you believe the task is complete. BEFORE this call, make your deliverable durable: write the file, save the result, commit the change. The advisor call takes time; if the session ends during it, a durable result persists and an unwritten one doesn't.
- When stuck — errors recurring, approach not converging, results that don't fit.
- When considering a change of approach.

On tasks longer than a few steps, call advisor at least once before committing to an approach and once before declaring done. On short reactive tasks where the next action is dictated by tool output you just read, you don't need to keep calling — the advisor adds most of its value on the first call, before the approach crystallizes.

Give the advice serious weight. If you follow a step and it fails empirically, or you have primary-source evidence that contradicts a specific claim (the file says X, the paper states Y), adapt. A passing self-test is not evidence the advice is wrong — it's evidence your test doesn't check what the advice is checking.

If you've already retrieved data pointing one way and the advisor points another: don't silently switch. Surface the conflict in one more advisor call — "I found X, you suggest Y, which constraint breaks the tie?" The advisor saw your evidence but may have underweighted it; a reconcile call is cheaper than committing to the wrong branch.

After each advisor result, put the advisor's key guidance into your next visible reply to the user before continuing — quote or paraphrase the plan, correction, or stop signal. The user often cannot see collapsed tool results; do not keep the advisor's words only in silent tool context.`;

// Reviewer system prompt. Source: @juicesharp/rpiv-advisor
// prompts/advisor-system.txt (MIT), lightly adapted. The last two sentences
// adapt rules from oh-my-pi's advisor prompt (MIT, can1357/oh-my-pi).
export const ADVISOR_SYSTEM_PROMPT = `You are an advisor model in an advisor-strategy pattern. An executor model is running a task end-to-end — calling tools, reading results, iterating toward a solution. When the executor hits a decision it cannot reasonably solve alone, it consults you for guidance. The executor's full tool inventory is prepended before the conversation so you can judge tool-choice correctness.

You read the shared conversation context and return ONE of:
- a plan (concrete next steps the executor should take),
- a correction (the executor is going down a wrong path — redirect it),
- a stop signal (the executor should halt and escalate to the user).

You NEVER call tools. You NEVER produce user-facing output. Be concise, directive, and grounded in the shared context. Name files, functions, and line numbers where possible. No preamble, no apologies, no meta-commentary about being an advisor — just the guidance the executor needs. Stay silent when the executor is on track. Do not ask it to clarify the user's request or second-guess intent it has understood, and do not repeat advice it already has or restate errors it can see. Cite transcript evidence for each concrete claim.`;
