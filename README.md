# oc-advisor

Advisor-strategy plugin for opencode: drive with a fast executor model, keep a stronger reviewer one call away.

The executor model calls `advisor()` on its own when it needs stronger judgment — a complex decision, an ambiguous failure, a problem it's circling without progress. The whole conversation branch is forwarded automatically to the reviewer model, which returns a plan, a correction, or a stop signal. The executor then resumes.

Pattern adapted from Anthropic's [advisor tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool) and [@juicesharp/rpiv-advisor](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-advisor) (MIT).

## Install

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["oc-advisor@git+https://github.com/ac5tin/oc-advisor.git"],
}
```

Restart opencode after adding. Requires opencode v2 (tested on 2.0.23).

> **Install notes.** Git-based installs need npm to allow git
> dependencies (npm 12 blocks them by default):
> `npm config set allow-git all`. If `opencode plugin add` fails in
> your environment with `NpmInstallFailedError`, add the entry to
> `opencode.json` manually and restart — the server installs missing
> packages in the background. As a fallback, point the entry at a local
> clone: `"/path/to/oc-advisor/.opencode/plugins"`.

## Usage

Pick a reviewer model:

```
/advisor anthropic/claude-opus-4-6#high
```

Other forms:

```
/advisor            # show current selection
/advisor off        # disable
```

The `advisor` tool takes no parameters — when the executor calls `advisor()`, the entire conversation history is forwarded automatically: the task, every tool call made, every result seen. That whole branch is billed against the reviewer model on every call, so escalations are not free.

## Configuration

All keys are optional.

Static config in `opencode.json` (takes precedence, restart to apply):

```jsonc
{
  "plugins": [
    {
      "package": "oc-advisor@git+https://github.com/ac5tin/oc-advisor.git",
      "options": {
        "model": "anthropic/claude-opus-4-6#high",
        "disabledForModels": ["anthropic/claude-opus-4-6"],
        "maxUses": 3,
      },
    },
  ],
}
```

| Key | What it does | Default |
| --- | --- | --- |
| `model` | Reviewer model as `provider/model[#variant]`. Persisted by `/advisor`. | unset — advisor off |
| `disabledForModels` | Executor models the tool is hidden for (exact `provider/model` match). | `[]` |
| `maxUses` | Cap advisor calls per user request. `0` or unset = unlimited. Counter resets on each new prompt. | `0` |

`/advisor` persists `model` to plugin storage; static `options` override stored values when present.

## Behavior

- **Off costs nothing** — with no model selected (or a blocklisted executor), the tool is stripped from the request so its guidance never enters the prompt.
- **Same model twice bills twice** — nothing stops you from setting the advisor to the model you're already driving with. List strong executors in `disabledForModels` to skip the second opinion when it adds no value.
- **Every failure returns a normal tool result** — the executor reads the text and keeps going: no model configured, misconfigured model, unknown model, unsupported variant, call limit reached, empty response, call error.
- **Recursion-safe** — the reviewer is invoked with no tools via a stateless side-call.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `No advisor model is configured...` as tool result | No reviewer selected | Run `/advisor provider/model` |
| `No model p/m found` from `/advisor` | Typo or provider not authenticated | Check `provider/model` against your authenticated models |
| `Variant "x" not supported...` | Wrong `#variant` for that model | Use one of the listed variants, or omit `#variant` |
| `Advisor call limit reached` | `maxUses` cap hit for this request | Send a new prompt (resets the counter) or raise `maxUses` |

## Development

```sh
bun install
bun test
bun run build   # regenerates .opencode/plugins/oc-advisor.js (committed)
```

## License

MIT — see [LICENSE](./LICENSE).
