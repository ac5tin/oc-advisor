# Push mode

By default the advisor is **pull-only**: the executor decides when to call `advisor()`. Push mode adds a second path: after the executor finishes a run, the reviewer reads the finished work and may post **one short note** into the session. The executor sees that note on its next turn.

Push mode is **off by default**. Nothing in this document applies until you turn it on.

---

## 1. Quick start

Turn it on for the current install:

```
/advisor push agent-end
```

Check what is active:

```
/advisor push
```

Turn it off again:

```
/advisor push off
```

Changes made with `/advisor push` are saved and apply from the next run. A static value in `opencode.json` takes precedence over the saved value (see section 6).

---

## 2. Every setting, exactly

| Setting | Type | Default | Allowed values | What it means |
| --- | --- | --- | --- | --- |
| `mode` | string | `"off"` | `"off"`, `"agent-end"` | `off`: no review after a run. `agent-end`: the reviewer runs after each finished run, subject to the other settings. |
| `minSeverity` | string | `"concern"` | `"nit"`, `"concern"`, `"blocker"` | The lowest severity that is posted. `concern` posts concerns and blockers and drops nits. `blocker` posts only blockers. `nit` posts everything. |
| `cooldownTurns` | integer ≥ 0 | `3` | `0` and up | After a note is posted, this many **following finished runs** are skipped without calling the reviewer. `0` means no cooldown. |
| `maxPerPrompt` | integer ≥ 0 | `2` | `0` and up | The most notes posted for one user prompt. The count resets when you send a new prompt. `0` means push never posts. |
| `projectNotes` | boolean | `false` | `true`, `false` | When `true`, the reviewer also reads `.opencode/advisor.md` from the project and treats it as priorities. Set with `/advisor notes on`. |

### What counts as a "finished run"

A finished run is a `session.execution.succeeded` event. It fires once a run completes successfully. Runs that are interrupted or fail do not trigger a review.

### What the reviewer must reply

The reviewer is told to answer in one of three forms:

| Reply | Meaning | Posted? |
| --- | --- | --- |
| `SILENT` (or an empty reply) | Nothing material needs the executor's attention. | No |
| `[nit] …` | A low-stakes cleanup or simplification. | Only if `minSeverity` is `nit` |
| `[concern] …` | A material risk, wrong direction, or missing constraint. | If `minSeverity` is `nit` or `concern` |
| `[blocker] …` | Continuing would clearly waste work or produce broken output. | Yes, for every `minSeverity` setting |
| Anything without a tag | Treated as `[nit]`. | Only if `minSeverity` is `nit` |

Replies are capped at about three sentences by instruction. The cap is not enforced in code.

---

## 3. What happens after each finished run

Checks run in this order. The first one that fails ends the run with no note and no reviewer call:

1. `mode` is `agent-end`, and a model is configured with `/advisor`.
2. The executor that just ran is not in `disabledForModels` (a `minEffort` entry is evaluated against its `#variant`).
3. **Cooldown.** If a cooldown is active, it is reduced by one and the run is skipped. **No reviewer call is made.**
4. **Per-prompt cap.** If `maxPerPrompt` notes were already posted for this prompt, stop. **No reviewer call is made.**
5. **Review.** The reviewer runs on the full transcript, using the same budget as a pull call.
6. **Parse** the reply (section 2).
7. **Severity.** Stop if the severity is below `minSeverity`, or is `SILENT`.
8. **Repeat.** Stop if the note matches one of the last five posted notes after normalizing case and punctuation.
9. **Post.** The note is added to the session as a queued synthetic message, labelled `Advisor note (<severity>): <text>`.

A posted note starts a cooldown of `cooldownTurns` and counts toward `maxPerPrompt`.

**Cost:** a reviewer call happens at step 5. Steps 3 and 4 avoid calls. A silent review still costs a call, and it does not start a cooldown. See section 7.

---

## 4. Recommended configurations

These are example settings for `opencode.json`. They are optional. `/advisor push agent-end` alone gives the defaults.

### A. Recommended: enable with defaults

```jsonc
{
  "plugins": [
    {
      "package": "oc-advisor@git+https://github.com/ac5tin/oc-advisor.git",
      "options": {
        "push": { "mode": "agent-end" }
      }
    }
  ]
}
```

Posts concerns and blockers, waits 3 finished runs after a note, and posts at most 2 notes per prompt. This suits a cheap executor, such as Haiku, with a stronger reviewer.

### B. Quiet: blockers only, one note per prompt

```jsonc
"options": {
  "push": { "mode": "agent-end", "minSeverity": "blocker", "cooldownTurns": 5, "maxPerPrompt": 1 }
}
```

Use this when interruptions are expensive for you. It posts only when continuing would clearly waste work.

### C. Notes from project priorities

```jsonc
"options": {
  "push": { "mode": "agent-end" },
  "projectNotes": true
}
```

Create `.opencode/advisor.md` in the project. Describe what the reviewer should prioritise, for example "prefer small diffs; never edit generated files". Only the first 8,000 characters are read.

### D. Chatty: not recommended

```jsonc
"options": {
  "push": { "mode": "agent-end", "minSeverity": "nit", "cooldownTurns": 0, "maxPerPrompt": 5 }
}
```

Every finished run is reviewed and up to five notes can be posted per prompt. This raises cost the most, and it adds nit-level noise. Use it only to tune the reviewer.

### E. Off, with project notes for pull calls

```jsonc
"options": {
  "projectNotes": true
}
```

Pull calls get the project priorities, and nothing is pushed.

---

## 5. Command reference

| Command | Effect |
| --- | --- |
| `/advisor push` | Shows the current mode, minimum severity, cooldown, per-prompt cap, and project-notes state. |
| `/advisor push off` | Sets `mode` to `off`. |
| `/advisor push agent-end` | Sets `mode` to `agent-end`. |
| `/advisor push min nit` | Sets `minSeverity` to `nit`. |
| `/advisor push min concern` | Sets `minSeverity` to `concern`. |
| `/advisor push min blocker` | Sets `minSeverity` to `blocker`. |
| `/advisor push cooldown N` | Sets `cooldownTurns` to `N`, a whole number ≥ 0. |
| `/advisor push max N` | Sets `maxPerPrompt` to `N`, a whole number ≥ 0. |
| `/advisor notes on` | Sets `projectNotes` to `true`. |
| `/advisor notes off` | Sets `projectNotes` to `false`. |

Invalid input, such as `/advisor push every-turn` or `/advisor push max -1`, is rejected with the usage line and nothing is saved.

Other advisor commands are unchanged: `/advisor` shows the reviewer and push mode, `/advisor <provider/model>` sets the reviewer, `/advisor off` disables the advisor.

---

## 6. Where settings come from

Settings are read on every run. Two sources are merged:

1. **Saved values** from `/advisor` and `/advisor push` / `/advisor notes`, stored in plugin storage.
2. **Static values** under `options` in `opencode.json`.

A static value **overrides the saved value for that key**, on every read. So if `opencode.json` sets `push.mode` to `agent-end`, then `/advisor push off` saves `off`, but the effective mode stays `agent-end` until you remove the key from `opencode.json`. The command replies with what it saved, not what is in effect.

Invalid static values are dropped, and the default for that key applies. For example, `"mode": "every-turn"` falls back to `"off"`.

---

## 7. Cost and limits

- **Pull calls are not affected.** Push reviews do not count toward `maxUses`, and `maxUses` does not limit pushes.
- **Each eligible finished run is one reviewer call**, including silent ones. In a normal session, that is about one call per prompt. A session that produces several finished runs per prompt makes one call for each.
- **Cooldown and the per-prompt cap limit posted notes, not reviewer calls.** A silent review does not start a cooldown, so silent reviews can repeat on every finished run. If you want a hard limit on reviewer calls, set `mode` to `off` when you are not using push.
- **Reviewer failures are silent.** If the reviewer model is not available, the call errors, or the reply is empty, no note is posted and nothing is shown. Check `/advisor` to confirm the reviewer is set.
- **Each reviewer call is billed** against the reviewer model at its rates, with the full transcript as input.

---

## 8. What the executor and user see

- A posted note appears in the session as a message beginning `Advisor note (concern): …`. The executor reads it as part of the transcript.
- A note is **queued**. It does not start a new reply by itself. It is delivered on the next turn.
- Advisor notes are **not sent back to the reviewer**, so the reviewer does not review its own earlier notes.
- Deleting a session removes its push state.

---

## 9. Known limits and what is not verified

- **Not tested against a live session.** The event name, the queued delivery, and the note appearing in the transcript come from the SDK types and documentation. They have not been run end to end yet. Verify on a real session before relying on push mode.
- **Duplicate detection is text-based.** Only exact matches after normalizing case and punctuation are caught. Two notes that say the same thing in different words are both posted.
- **Only the last five notes** are remembered for duplicate checks, and only within one session.
- **Length is not enforced.** The reviewer is asked for at most three sentences.
- **There is no `every-turn` mode.** Push runs after finished runs only. Turn-by-turn review is not implemented.
- **No fallback reviewer.** If the reviewer fails, push does nothing that run. A fallback chain is planned but not built.

---

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| No notes ever appear | `mode` is `off`, or no reviewer is set | Run `/advisor push` and `/advisor`. |
| Notes appear only rarely | Cooldown, the per-prompt cap, or silent reviews | Check `/advisor push`. Lower `cooldownTurns` or raise `maxPerPrompt`. |
| `/advisor push agent-end` says it saved but nothing changed | `opencode.json` sets `push.mode` | Remove the static key, or edit it there (section 6). |
| Nits never appear | `minSeverity` is `concern` by default | `/advisor push min nit`, if you want them. |
| Notes repeat in different words | Duplicate detection is text-based | Lower `maxPerPrompt`, or switch to `blocker`. |
| Notes are too frequent or expensive | Chatty settings, or many finished runs per prompt | Use configuration B, or set `mode` to `off`. |
