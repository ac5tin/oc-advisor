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

/** Exact provider/model match (variant ignored). Empty list never blocks. */
export function isDisabledModel(executorRef: string, disabledForModels: readonly string[]): boolean {
  const key = canonicalKey(executorRef);
  return disabledForModels.some((entry) => canonicalKey(entry) === key);
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
}

export interface BranchMessage {
  type: string;
  text?: string;
  agent?: string;
  model?: { providerID?: string; id?: string };
  content?: BranchPart[];
}

function renderMessage(msg: BranchMessage, inflightCallId: string | undefined): string | null {
  if (msg.type === "user" || msg.type === "synthetic") {
    if (!msg.text) return null;
    return `## ${msg.type}:\n${msg.text}`;
  }
  const parts = (msg.content ?? []).filter((p) => p.id !== inflightCallId);
  // Message carried the in-flight advisor call: drop it whole (tail massage).
  if (msg.content !== undefined && msg.content.some((p) => p.id === inflightCallId)) return null;
  const who = msg.agent ?? (msg.model ? `${msg.model.providerID}/${msg.model.id}` : "assistant");
  const lines: string[] = [];
  for (const p of parts) {
    if (typeof p.text === "string" && p.text) lines.push(p.text);
    else if (p.name) lines.push(`tool call ${p.name}${p.id ? ` (${p.id})` : ""}`);
  }
  if (msg.text && lines.length === 0) lines.push(msg.text);
  if (lines.length === 0) return null;
  return `## assistant (${who}):\n${lines.join("\n")}`;
}

/**
 * Serialize the executor branch for the reviewer: tool inventory prefix,
 * in-flight advisor call stripped, guaranteed user-role tail.
 */
export function buildAdvisorPrompt(
  messages: readonly BranchMessage[],
  opts: { inflightCallId?: string; toolNames: readonly string[] },
): string {
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
  if (!lastWasUser) out.push("## user:\nPlease advise on the executor's situation above.");
  return out.join("\n");
}

// Executor guidance injected into the agent loop. Source: Anthropic's
// suggested system prompt for coding tasks (advisor-tool docs), tool names
// adapted to opencode (edit/write/shell), plus the visible-restatement rule
// from @juicesharp/rpiv-advisor.
export const EXECUTOR_GUIDANCE = `You have access to an \`advisor\` tool backed by a stronger reviewer model. It takes NO parameters — when you call advisor(), your entire conversation history is automatically forwarded. They see the task, every tool call you've made, every result you've seen.

Call advisor BEFORE substantive work — before writing, before committing to an interpretation, before building on an assumption. If the task requires orientation first (finding files, fetching a source, seeing what's there), do that, then call advisor. Orientation is not substantive work. Writing, editing, and declaring an answer are.

Also call advisor:
- When you believe the task is complete. BEFORE this call, make your deliverable durable: write the file, save the result, commit the change. The advisor call takes time; if the session ends during it, a durable result persists and an unwritten one doesn't.
- When stuck — errors recurring, approach not converging, results that don't fit.
- When considering a change of approach.

On tasks longer than a few steps, call advisor at least once before committing to an approach and once before declaring done. On short reactive tasks where the next action is dictated by tool output you just read, you don't need to keep calling — the advisor adds most of its value on the first call, before the approach crystallizes.

Give the advice serious weight. If you follow a step and it fails empirically, or you have primary-source evidence that contradicts a specific claim (the file says X, the paper states Y), adapt. A passing self-test is not evidence the advice is wrong — it's evidence your test doesn't check what the advice is checking.

If you've already retrieved data pointing one way and the advisor points another: don't silently switch. Surface the conflict in one more advisor call — "I found X, you suggest Y, which constraint breaks the tie?" A reconcile call is cheaper than committing to the wrong branch.

After each advisor result, put the advisor's key guidance into your next visible reply to the user before continuing — quote or paraphrase the plan, correction, or stop signal. The user often cannot see collapsed tool results; do not keep the advisor's words only in silent tool context.`;

// Reviewer system prompt. Source: @juicesharp/rpiv-advisor
// prompts/advisor-system.txt (MIT), lightly adapted.
export const ADVISOR_SYSTEM_PROMPT = `You are an advisor model in an advisor-strategy pattern. An executor model is running a task end-to-end — calling tools, reading results, iterating toward a solution. When the executor hits a decision it cannot reasonably solve alone, it consults you for guidance. The executor's full tool inventory is prepended before the conversation so you can judge tool-choice correctness.

You read the shared conversation context and return ONE of:
- a plan (concrete next steps the executor should take),
- a correction (the executor is going down a wrong path — redirect it),
- a stop signal (the executor should halt and escalate to the user).

You NEVER call tools. You NEVER produce user-facing output. Be concise, directive, and grounded in the shared context. Name files, functions, and line numbers where possible. No preamble, no apologies, no meta-commentary about being an advisor — just the guidance the executor needs.`;
