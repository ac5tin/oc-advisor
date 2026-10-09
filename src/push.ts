// Push mode: after an executor run finishes, the reviewer may volunteer a note
// that is injected into the session. Pure helpers only; wiring lives in index.ts.

export type Severity = "nit" | "concern" | "blocker";
export type PushMode = "off" | "agent-end";
export type ReviewSeverity = Severity | "silent";

export interface PushConfig {
  mode: PushMode;
  minSeverity: Severity;
  cooldownTurns: number;
  maxPerPrompt: number;
}

export const DEFAULT_PUSH: PushConfig = { mode: "off", minSeverity: "concern", cooldownTurns: 3, maxPerPrompt: 2 };

export const ADVISOR_NOTE_PREFIX = "Advisor note";
const RECENT_LIMIT = 5;
const RANK: Record<ReviewSeverity, number> = { silent: -1, nit: 0, concern: 1, blocker: 2 };

/** Appended to the reviewer prompt in push mode. */
export const PUSH_INSTRUCTIONS = `You are reviewing the executor's latest completed run, not answering a question. Reply with exactly SILENT when nothing material needs the executor's attention. Otherwise start your reply with one tag, [nit], [concern] or [blocker], then the advice in at most three sentences. Use [blocker] only when continuing would clearly waste work or produce broken output. Never repeat advice listed under "already raised".`;

export function parseReview(text: string): { severity: ReviewSeverity; body: string } {
  const trimmed = text.trim();
  if (trimmed === "" || /^silent\b/i.test(trimmed)) return { severity: "silent", body: "" };
  const tag = /^\[(nit|concern|blocker)\]\s*/i.exec(trimmed);
  if (tag) return { severity: tag[1].toLowerCase() as Severity, body: trimmed.slice(tag[0].length).trim() };
  return { severity: "nit", body: trimmed };
}

export function shouldPush(severity: ReviewSeverity, minSeverity: Severity): boolean {
  return RANK[severity] >= RANK[minSeverity];
}

export interface PushState {
  cooldown: number;
  pushesThisPrompt: number;
  recent: string[];
  raw: string[];
}

export function newPushState(): PushState {
  return { cooldown: 0, pushesThisPrompt: 0, recent: [], raw: [] };
}

export function canPush(state: PushState, cfg: PushConfig): boolean {
  return state.cooldown === 0 && state.pushesThisPrompt < cfg.maxPerPrompt;
}

/** Counts down one skipped agent-end while a cooldown is active. */
export function skipTurn(state: PushState): void {
  if (state.cooldown > 0) state.cooldown -= 1;
}

export function recordPush(state: PushState, body: string, cfg: PushConfig): void {
  state.pushesThisPrompt += 1;
  state.cooldown = cfg.cooldownTurns;
  state.recent = [normalizeNote(body), ...state.recent].slice(0, RECENT_LIMIT);
  state.raw = [body, ...state.raw].slice(0, RECENT_LIMIT);
}

export function resetPrompt(state: PushState): void {
  state.pushesThisPrompt = 0;
}

export function isRepeat(state: PushState, body: string): boolean {
  return state.recent.includes(normalizeNote(body));
}

export function normalizeNote(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function pushNoteText(severity: Severity, body: string): string {
  return `${ADVISOR_NOTE_PREFIX} (${severity}): ${body}`;
}

export function isAdvisorNote(text: string): boolean {
  return text.startsWith(`${ADVISOR_NOTE_PREFIX} (`);
}
