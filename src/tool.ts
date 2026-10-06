import { AdvisorError, maxUsesExceeded, parseModelRef, runAdvisorCall, type ModelRef } from "./advisor";
import type { AdvisorConfig } from "./config";

export const SHORT_DESCRIPTION =
  "Escalate to a stronger reviewer model for guidance. Takes NO parameters — your entire conversation is forwarded automatically. Call BEFORE substantive work, when stuck, or before declaring done.";

export interface ToolHost {
  loadConfig(): Promise<AdvisorConfig>;
  readContext(sessionID: string): Promise<unknown>;
  listToolNames(): Promise<string[]>;
  generateText(model: ModelRef, prompt: string, opts?: { signal?: AbortSignal }): Promise<string>;
}

export interface AdvisorTool {
  definition: {
    name: string;
    description: string;
    input: { type: string; properties: Record<string, never>; additionalProperties: boolean };
    options?: { codemode?: boolean };
    execute(input: unknown, context: { sessionID: string; id: string; signal?: AbortSignal }): Promise<{ content: string }>;
  };
  resetUses(sessionID: string): void;
}

/** Advisor tool with injectable host. Use counter resets on each new user prompt. */
export function createAdvisorTool(host: ToolHost): AdvisorTool {
  const uses = new Map<string, number>();

  return {
    definition: {
      name: "advisor",
      description: SHORT_DESCRIPTION,
      input: { type: "object", properties: {}, additionalProperties: false },
      options: { codemode: false },
      execute: async (_input: unknown, context: { sessionID: string; id: string; signal?: AbortSignal }) => {
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
      },
    },
    resetUses(sessionID: string) {
      uses.set(sessionID, 0);
    },
  };
}
