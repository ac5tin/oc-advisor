import { parseAdvisorArgs, parseModelRef } from "./advisor";
import type { AdvisorConfig } from "./config";

function toArray(models: unknown): any[] {
  if (Array.isArray(models)) return models as any[];
  const obj = (models ?? {}) as Record<string, any>;
  if (Array.isArray(obj.data)) return obj.data;
  if (Array.isArray(obj.models)) return obj.models;
  return Object.values(obj);
}

export interface CommandHost {
  load(): Promise<AdvisorConfig>;
  save(config: AdvisorConfig): Promise<void>;
  listModels(): Promise<unknown>;
  prompt(input: { sessionID: string; text: string; delivery: unknown }): Promise<unknown>;
}

export interface AdvisorCommand {
  name: string;
  description: string;
  execute(input: { sessionID: string; prompt: { text?: string }; delivery: unknown }): Promise<void>;
}

/** /advisor command with injectable host: show | set provider/model[#variant] | off. */
export function createAdvisorCommand(host: CommandHost): AdvisorCommand {
  return {
    name: "advisor",
    description: "Select the advisor reviewer model: /advisor provider/model[#variant], /advisor off",
    execute: async ({ sessionID, prompt, delivery }) => {
      const reply = (text: string) => host.prompt({ sessionID, text, delivery });
      const config = await host.load();
      const arg = parseAdvisorArgs(prompt?.text ?? "");
      if (arg.action === "show") {
        await reply(
          config.model
            ? `Advisor: ${config.model}${config.maxUses > 0 ? ` (max ${config.maxUses} calls per request)` : ""}`
            : "Advisor: off. Set one with /advisor provider/model[#variant], e.g. /advisor anthropic/claude-opus-4-6#high",
        );
        return;
      }
      if (arg.action === "off") {
        await host.save({ ...config, model: undefined });
        await reply("Advisor disabled. Reply with one short confirmation.");
        return;
      }
      const ref = parseModelRef(arg.model);
      if (!ref) {
        await reply(
          `Invalid model "${arg.model}". Use provider/model[#variant], e.g. /advisor anthropic/claude-opus-4-6#high, or /advisor off.`,
        );
        return;
      }
      const all = toArray(await host.listModels());
      const found = all.find((m) => m.providerID === ref.providerID && (m.id === ref.id || m.modelID === ref.id));
      if (!found) {
        await reply(`No model ${ref.providerID}/${ref.id} found. Check the model name and try again.`);
        return;
      }
      if (
        ref.variant &&
        Array.isArray(found.variants) &&
        found.variants.length > 0 &&
        !found.variants.some((v: any) => v?.id === ref.variant)
      ) {
        const valid = found.variants.map((v: any) => v?.id).filter(Boolean).join(", ");
        await reply(`Variant "${ref.variant}" not supported by ${ref.providerID}/${ref.id}. Valid: ${valid}.`);
        return;
      }
      const canonical = `${ref.providerID}/${found.id ?? ref.id}${ref.variant ? `#${ref.variant}` : ""}`;
      await host.save({ ...config, model: canonical });
      await reply(`Advisor reviewer model set to ${canonical}. Reply with one short confirmation.`);
    },
  };
}
