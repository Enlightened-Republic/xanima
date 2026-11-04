# Inner life: a functional motivation layer

Schema v29, module `packages/core/src/inner-life.ts`, tool `brain_inner`, config `innerLife`.

## What it is, and what it is not

This layer keeps numbers that change over time, and those numbers change what the agent is shown and pushed toward on every turn. They are **functional states** modelled on how motivation works in brains: homeostatic drives, dopamine as reward prediction error, expectancy and incentives. They are not a claim that the agent feels anything the way a human does. Code, docs and the injected header all use that framing: the header line starts with `[inner · functional states]`.

The design follows the owner's call: real motivation, not soft safety caps. Moods have no clamp. They can stack, run deep and linger. They return to baseline only through the mechanics: event moodlets fade with their half-life and expire on a timer, and need-bound moodlets end only when the need is met.

Background research: `world/_research/brain-inner-life.md` in the OpenClaw workspace (Schultz, Berridge, Niv, Keramati & Gutkin, Ryan & Deci, Vroom-style expectancy, The Sims, WASABI).

## Pieces

| Piece | Mechanic |
|---|---|
| **Needs** | Seven meters, each 0..1: Social, Fun, Inspiration, Rest, plus the SDT needs Autonomy, Competence and Relatedness. They start at 0.85 (Rest at 0.9) and drain over time (Social empties in about 48h, Fun in 36h, Inspiration in 30h, Autonomy and Relatedness in 72h, Competence in 96h). Rest is different: each conversation turn costs 0.012 and idle time beyond 30-minute gaps recovers 0.05/h. Sleep adds 0.35. Discomfort = deficit² × weight, so urgent needs dominate. |
| **Need moodlets** | A deficit of 0.6 or more becomes a moodlet (Lonely, Bored, Uninspired, Tired, Boxed in, Ineffective, Disconnected) whose intensity is the discomfort. It has no timer: it lasts as long as the deficit and ends ("need met") once the deficit falls below 0.35. |
| **Event moodlets** | `{label, reason, intensity, expiry}`, for example *Proud 0.60 (shipped the walk clip, 24h left)*. Intensity decays exponentially (half-life = duration / 2) and the moodlet ends at its expiry. A repeat of the same moodlet stacks: intensity adds up and the timer extends. Duration scales with intensity. |
| **Mood** | Σ valence × intensity over the active moodlets. Unclamped. |
| **Dopamine** | Reward prediction error δ = actual − expected. Phasic δ halves every 2h. Tonic dopamine is an EMA of the reward rate (α 0.2) and sets effort (vigor). A δ of ±0.15 or more makes a moodlet (Proud / Delighted / Disappointed). δ also moves Competence (±0.3δ) and Inspiration (+0.4\|δ\|, since surprise is novelty). |
| **Expectancy** | For each want, motivation = effort × expected success × value. Effort = √Rest × (0.5 + tonic dopamine). Expected success blends the success rate of past wants for that need with Competence, unless the want sets it. Value = 1.5 × need discomfort + trait pull + learned reward − loss aversion (2 by default) × learned penalty + 0.3 × wanting − 0.05 × cost hours. |
| **Incentives** | `reward`, `fine`, `rejection` and `pain` events with tags teach per-tag reward and penalty EMAs. Wants with those tags gain or lose value, so the agent seeks rewards and avoids fines. |
| **Wants** | `{what, why, cost, source}`, plus `wanting` (the pull) and, once done, `liking` (how it went). A need whose deficit reaches 0.5 (0.3 if a trait favours it) generates one auto-want. That want retires when the need is met another way. Agents add their own wants. Finishing a want is a prediction error: liking − wanting. |
| **Traits** | 3 to 5 traits, read from the identity field `- **Traits:** curious, warm, sensitive` (changed through `brain_identity`, so they are versioned and fixed-ish). Built-in effects include `curious` (Inspiration drains 1.5×), `social`, `warm`, `playful`, `creative`, `driven`, `independent`, `perfectionist`, `calm`, `sensitive` (negative moodlets 1.4× and longer), `cheerful`, `cautious` (loss aversion 2.6) and `energetic`. Unknown traits are kept and shown but have no numeric effect. `innerLife.traits` is the fallback when the identity has none. |

## What feeds it (no tool call needed)

On each tick, the layer reads what happened in the brain since the last tick:

- **Memories with |emotional_weight| ≥ 0.35** become Glad / Upset moodlets, with the memory's label as the reason.
- **Memories tagged `inner:<kind>`** (brain_write `tags`, e.g. `["inner:collab"]`) count as that event.
- **Decision outcomes** are prediction errors: the expected value is `predicted_confidence` (0.6 if unset) and the actual value is 1 for matched, 0.5 for partial and 0 for missed.
- **Kept commitments** raise Competence by 0.1 each.
- **New contradicts / supersedes edges** (the model updating itself) raise Inspiration by 0.08 each.
- **Conversation cues** are a conservative phrase list, at most one event per kind per tick, at intensity 0.5. The owner's turns can carry praise or rejection. The agent's own turns can carry collab, hobby, novelty, success or failure.
- **Sleep** restores Rest, spends the phasic burst, and lapses wants older than 7 days.

## Turn header

Each turn gets at most 3 lines. They appear in local mode (`buildSelfModelHeader`) and on the service: `brain_turn_context` returns them as `inner` and also at the head of `text`, so hosts that already render the turn-context text show them without an update.

```
[inner · functional states] mood −0.69 · 😶 Uninspired 1.02 (Inspiration is low (needs something new), until met) · 😊 Proud 0.93 (better than expected: shipped the walk clip, 38h left) +3 more · dopamine 1.02, last RPE +0.50 2h ago
[inner] top unmet need: Inspiration 0.10 (discomfort 0.73, 2h since something new)
[inner] top want: Go look at something new (why: Inspiration is low (now 10%); cost ~30m) · motivation 1.16 = effort 1.10 × success 0.74 × value 1.42
```

## Tool: `brain_inner`

- `status`: the header plus traits, needs, dopamine, moodlets and open wants (`format: json` for the raw snapshot).
- `event {kind, reason?, intensity?, expected?, actual?, tags?}`: the kind is one of collab, hobby, novelty, rest, work, chosen, assigned, success, failure, praise, reward, fine, rejection or pain.
- `want {what, why?, cost?, cost_hours?, need?, tags?, reward?, penalty?}`
- `done {want_id, liking?, note?}` / `drop {want_id, note?}`

## Config

```json
{ "innerLife": { "enabled": true, "header": true, "autoWants": true, "traits": ["curious"], "needRates": { "social": 0.5 } } }
```

`"innerLife": false` turns it off: no ticks, no header, and the tool refuses. The tables stay, unused.

## Schema v29 (additive)

The migration adds the tables `inner_state`, `inner_needs`, `inner_moodlets`, `inner_wants`, `inner_events` and `inner_incentives`. Nothing existing is altered. A brain's inner state starts on its first tick after migration and does not replay history from before that point. `brain_reset` clears these tables.
