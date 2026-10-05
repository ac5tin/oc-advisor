import { parseModelRef } from "./advisor";

export interface AdvisorConfig {
  model?: string;
  disabledForModels: string[];
  maxUses: number;
}

export const DEFAULT_CONFIG: AdvisorConfig = { model: undefined, disabledForModels: [], maxUses: 0 };

export interface RawOptions {
  model?: unknown;
  disabledForModels?: unknown;
  maxUses?: unknown;
}

/** Keep only well-formed option values; everything else falls back to defaults. */
export function sanitizeOptions(raw: RawOptions | undefined): AdvisorConfig {
  const out: AdvisorConfig = { ...DEFAULT_CONFIG, disabledForModels: [] };
  if (!raw || typeof raw !== "object") return out;
  if (typeof raw.model === "string" && parseModelRef(raw.model)) out.model = raw.model.trim();
  if (Array.isArray(raw.disabledForModels)) {
    out.disabledForModels = raw.disabledForModels.filter(
      (e): e is string => typeof e === "string" && parseModelRef(e) !== null,
    );
  }
  if (typeof raw.maxUses === "number" && Number.isFinite(raw.maxUses) && raw.maxUses > 0) {
    out.maxUses = Math.floor(raw.maxUses);
  }
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
