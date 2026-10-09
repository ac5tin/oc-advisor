import { parseAdvisorArgs, parseModelRef } from "./advisor";
import type { AdvisorConfig } from "./config";
import type { PushConfig } from "./push";

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

function describePush(push: PushConfig, projectNotes: boolean): string {
  return [
    `Push mode: ${push.mode}`,
    `(min severity: ${push.minSeverity}, cooldown: ${push.cooldownTurns} agent-end runs,`,
    `max per prompt: ${push.maxPerPrompt}, project notes: ${projectNotes ? "on" : "off"}).`,
    "See docs/push-mode.md for what each setting does.",
  ].join(" ");
}

/** /advisor command with injectable host: show | set provider/model[#variant] | off | push … | notes on|off. */
export function createAdvisorCommand(host: CommandHost): AdvisorCommand {
  return {
    name: "advisor",
    description: "Advisor reviewer: /advisor provider/model[#variant] | off | push [off|agent-end|min|cooldown|max] | notes on|off",
    execute: async ({ sessionID, prompt, delivery }) => {
      const reply = (text: string) => host.prompt({ sessionID, text, delivery });
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
        const summary = arg.patch.mode !== undefined
          ? `Push mode set to ${push.mode}.`
          : "Push setting updated.";
        await reply(`${summary} ${describePush(push, config.projectNotes)}`);
        return;
      }
      if (arg.action === "notes") {
        await host.save({ ...config, projectNotes: arg.on });
        await reply(`Project notes ${arg.on ? "on" : "off"}: reads .opencode/advisor.md in the project when enabled.`);
        return;
      }
      if (arg.action === "show") {
        await reply(
          config.model
            ? `Advisor: ${config.model}${config.maxUses > 0 ? ` (max ${config.maxUses} calls per request)` : ""}. Push mode: ${config.push.mode}.`
            : "Advisor: off. Set one with /advisor provider/model[#variant], e.g. /advisor anthropic/claude-opus-4-6#high",
        );
        return;
      }
      if (arg.action === "off") {
        await host.save({ ...config, model: undefined });
        await reply("Advisor disabled (a static options.model in opencode.json will re-enable it on restart). Reply with one short confirmation.");
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
