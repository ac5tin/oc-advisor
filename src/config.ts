import { EFFORT_LEVELS, parseModelRef, type DisabledEntry } from "./advisor";
import { DEFAULT_PUSH, type PushConfig } from "./push";

export interface AdvisorConfig {
  model?: string;
  disabledForModels: DisabledEntry[];
  maxUses: number;
  push: PushConfig;
  projectNotes: boolean;
  mainAgentOnly: boolean;
}

function isDisabledEntry(entry: unknown): entry is DisabledEntry {
  if (typeof entry === "string") return parseModelRef(entry) !== null;
  if (!entry || typeof entry !== "object") return false;
  const { model, minEffort } = entry as { model?: unknown; minEffort?: unknown };
  return (
    typeof model === "string" &&
    parseModelRef(model) !== null &&
    (minEffort === undefined || EFFORT_LEVELS.includes(minEffort as (typeof EFFORT_LEVELS)[number]))
  );
}

export const DEFAULT_CONFIG: AdvisorConfig = {
  model: undefined,
  disabledForModels: [],
  maxUses: 0,
  push: DEFAULT_PUSH,
  projectNotes: false,
  mainAgentOnly: false,
};

export interface RawOptions {
  model?: unknown;
  disabledForModels?: unknown;
  maxUses?: unknown;
  push?: unknown;
  projectNotes?: unknown;
  mainAgentOnly?: unknown;
}

const PUSH_MODES = ["off", "agent-end"] as const;
const SEVERITIES = ["nit", "concern", "blocker"] as const;

/** Only the push keys that are present and valid; absent keys are left out. */
export function sanitizePush(raw: unknown): Partial<PushConfig> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<PushConfig> = {};
  if (PUSH_MODES.includes(r.mode as (typeof PUSH_MODES)[number])) out.mode = r.mode as PushConfig["mode"];
  if (SEVERITIES.includes(r.minSeverity as (typeof SEVERITIES)[number])) {
    out.minSeverity = r.minSeverity as PushConfig["minSeverity"];
  }
  if (isNonNegativeInt(r.cooldownTurns)) out.cooldownTurns = r.cooldownTurns;
  if (isNonNegativeInt(r.maxPerPrompt)) out.maxPerPrompt = r.maxPerPrompt;
  return out;
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/** Keep only well-formed option values; everything else falls back to defaults. */
export function sanitizeOptions(raw: RawOptions | undefined): AdvisorConfig {
  const out: AdvisorConfig = { ...DEFAULT_CONFIG, disabledForModels: [], push: { ...DEFAULT_PUSH } };
  if (!raw || typeof raw !== "object") return out;
  if (typeof raw.model === "string" && parseModelRef(raw.model)) out.model = raw.model.trim();
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

function sanitizeStored(raw: unknown): Partial<AdvisorConfig> {
  if (!raw || typeof raw !== "object") return {};
  return sanitizeOptions(raw as RawOptions);
}

/**
 * Resolve effective config: plugin options (opencode.json) win when present,
 * stored /advisor selection fills the rest, defaults cover the remainder.
 */
export async function resolveConfig(storage: {
  get(key: string): Promise<unknown>;
}): Promise<AdvisorConfig> {
  const stored = sanitizeStored(await storage.get("config"));
  return { ...DEFAULT_CONFIG, ...stored };
}

export function applyOptions(base: AdvisorConfig, raw: RawOptions | undefined): AdvisorConfig {
  const opts = sanitizeOptions(raw);
  const out = { ...base };
  if (opts.model !== undefined) out.model = opts.model;
  if (raw && typeof raw === "object" && Array.isArray(raw.disabledForModels)) {
    out.disabledForModels = opts.disabledForModels;
  }
  if (opts.maxUses > 0) out.maxUses = opts.maxUses;
  out.push = { ...base.push, ...sanitizePush(raw?.push) };
  if (raw && typeof raw === "object" && raw.projectNotes !== undefined) out.projectNotes = opts.projectNotes;
  // mainAgentOnly is static-only: opencode.json is the sole source; stored config is never consulted.
  out.mainAgentOnly = opts.mainAgentOnly;
  return out;
}

export async function saveConfig(
  storage: { set(key: string, value: unknown): Promise<void> },
  config: AdvisorConfig,
): Promise<void> {
  await storage.set("config", config);
}

/** Fresh read on every call: stored selection with static options overlaid. Never cached. */
export async function readConfig(
  storage: { get(key: string): Promise<unknown> },
  options: RawOptions | undefined,
): Promise<AdvisorConfig> {
  return applyOptions(await resolveConfig(storage), options);
}
