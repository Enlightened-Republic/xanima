# Inner life: a functional motivation layer

Schema v29 (mood ladder: v30, continuity: v31), modules `packages/core/src/inner-life.ts` and `packages/core/src/inner-continuity.ts`, tool `brain_inner`, config `innerLife`.

## What it is, and what it is not

This layer keeps numbers that change over time, and those numbers change what the agent is shown and pushed toward on every turn. They are **functional states** modelled on how motivation works in brains: homeostatic drives, dopamine as reward prediction error, expectancy and incentives. They are not a claim that the agent feels anything the way a human does. Code, docs and the injected header all use that framing: the header line starts with `[inner · functional states]`.

The design follows the owner's call: real motivation, not soft safety caps. Moods have no clamp. They can stack, run deep and linger. They return to baseline only through the mechanics: event moodlets fade with their half-life and expire on a timer, and need-bound moodlets end only when the need is met.

Background research: `world/_research/brain-inner-life.md` in the OpenClaw workspace (Schultz, Berridge, Niv, Keramati & Gutkin, Ryan & Deci, Vroom-style expectancy, The Sims, WASABI).

## Pieces

| Piece | Mechanic |
|---|---|
| **Needs** | Seven meters, each 0..1: Social, Fun, Inspiration, Rest, plus the SDT needs Autonomy, Competence and Relatedness. They start at 0.85 (Rest at 0.9) and drain over time (Social empties in about 48h, Fun in 36h, Inspiration in 30h, Autonomy and Relatedness in 72h, Competence in 96h). Rest is different: each conversation turn costs 0.003 and idle time beyond 30-minute gaps recovers 0.18/h (a work event costs 0.04). Sleep adds 0.35. Discomfort = deficit² × weight, so urgent needs dominate. |
| **Need moodlets** | A deficit of 0.6 or more becomes a moodlet (Lonely, Bored, Uninspired, Tired, Boxed in, Ineffective, Disconnected) whose intensity is the discomfort. It has no timer: it lasts as long as the deficit and ends ("need met") once the deficit falls below 0.35. |
| **Event moodlets** | `{label, reason, intensity, expiry}`, for example *Proud 0.60 (shipped the walk clip, 24h left)*. Intensity decays exponentially (half-life = duration / 2) and the moodlet ends at its expiry. A repeat of the same moodlet stacks: intensity adds up and the timer extends. Duration scales with intensity. |
| **Mood** | Σ valence × intensity over the active moodlets. Unclamped. |
| **Dopamine** | Reward prediction error δ = actual − expected. Phasic δ halves every 2h. Tonic dopamine is an EMA of the reward rate (α 0.2) and sets effort (vigor). A δ of ±0.15 or more makes a moodlet (Proud / Delighted / Disappointed). δ also moves Competence (±0.3δ) and Inspiration (+0.4\|δ\|, since surprise is novelty). |
| **Expectancy** | For each want, motivation = effort × expected success × value. Effort = √Rest × (0.5 + tonic dopamine). Expected success blends the success rate of past wants for that need with Competence, unless the want sets it. Value = 1.5 × need discomfort + trait pull + learned reward − loss aversion (2 by default) × learned penalty + 0.3 × wanting − 0.05 × cost hours. |
| **Incentives** | `reward`, `fine`, `rejection` and `pain` events with tags teach per-tag reward and penalty EMAs. Wants with those tags gain or lose value, so the agent seeks rewards and avoids fines. |
| **Wants** | `{what, why, cost, source}`, plus `wanting` (the pull) and, once done, `liking` (how it went). A need whose deficit reaches 0.5 (0.3 if a trait favours it) generates one auto-want. That want retires when the need is met another way. Agents add their own wants. Finishing a want is a prediction error: liking − wanting. |
| **Traits** | up to 8 traits (`MAX_TRAITS`; extras ignored), read from the identity field `- **Traits:** curious, warm, sensitive` (changed through `brain_identity`, so they are versioned and fixed-ish). Built-in effects include `curious` (Inspiration drains 1.5×), `social`, `warm`, `playful`, `creative`, `driven`, `independent`, `perfectionist`, `calm`, `sensitive` (negative moodlets 1.4× and longer), `cheerful`, `cautious` (loss aversion 2.6) and `energetic`. Crew traits too: `restless` (Inspiration and Fun drain 1.4×, wants Inspiration), `loyal` (Relatedness weight 1.4), `secretly loyal`, `petty` (negative moodlets 1.2×, moodlets last 1.3×), `vain` (Competence weight 1.2, praise lands 1.4×), `blunt` (negative 0.85×), `sharp`, `direct`, `precise`, `exacting` (Competence weight 1.3, misses sting 1.3×), `sharp-tongued`, `allusive`, `amused`, `dry-humored`, `protective`, `careful`, `tinkerer`, `builder` (Inspiration drains 0.85×; a success feeds +0.2 Inspiration, work +0.03; synonyms: builds, maker, likes to build, ships it), `chaotic`. Traits can also **feed or drain on events**: builder/tinkerer feed Inspiration on success and work, curious feeds +0.2 on novelty and drains a little on assigned work; per-event trait feeds are clamped to ±0.25. **Inspiration's trait drain multiplier is capped at 1.3×** (config `needRates` still apply on top). **Owner chat:** a user turn with `meta.owner=true` (stamped by xanima-openclaw from `commands.ownerAllowFrom`; fallbacks `innerLife.ownerAllowFrom` / `innerLife.ownerSessionIds`) is an `owner_chat` event: Inspiration +0.25, Relatedness +0.15, Inspired moodlet, at most 2 per rolling hour. Every factor stays within 0.7..1.5. **Invented phrases work:** an exact trait (or synonym) wins; otherwise every known trait word and synonym inside the phrase applies (`curious mildly chaotic tinkerer` → curious, chaotic at half strength, tinkerer; `builds it then goes and looks` → curious, builder). A softener right before a word (`a little`, `mildly`, `slightly`…) applies it at half strength. A trait named in two phrases applies once. Unknown words are kept and shown with no numeric effect; nothing is dropped. Source order: identity field `Traits`, else `innerLife.traitsByAgent[<brain id>]`, else `innerLife.traits`. `brain_inner status` shows what each phrase maps to and the resulting drain multipliers (`traitEffects` / `drainRates` in json). |
| **Mood ladder** | A named mood stored in `inner_state.mood_state`: Sad / Low / Okay / Good / Happy, with raw-mood boundaries −0.8, −0.25, +0.25, +0.8. Each tick it moves **at most one rung** toward the raw mood, and only once the raw mood is **0.1 past** the boundary (hysteresis, both ways). **Happy is earned:** entering it needs at least one good moodlet of intensity ≥ 0.5 (several small ones are not enough), and it drops back to Good once the strongest good moodlet falls below 0.25. **Inertia:** while the rung is Good or Happy, positive moodlets decay with a 1.5× longer half-life (their expiry stretches to match); while it is Low or Sad, negative ones do. Shown in the header (`mood Good → Happy +0.95`), in status, and as `moodState {rung, label, since, heading}` in json. Rung changes are logged to `inner_events` (kind `mood`). |

## What feeds it (no tool call needed)

On each tick, the layer reads what happened in the brain since the last tick:

- **Memories with |emotional_weight| ≥ 0.35** become Glad / Upset moodlets, with the memory's label as the reason.
- **Memories tagged `inner:<kind>`** (brain_write `tags`, e.g. `["inner:collab"]`) count as that event.
- **Decision outcomes** are prediction errors: the expected value is `predicted_confidence` (0.6 if unset) and the actual value is 1 for matched, 0.5 for partial and 0 for missed.
- **Kept commitments** raise Competence by 0.1 each.
- **New contradicts / supersedes edges** (the model updating itself) raise Inspiration by 0.08 each.
- **Conversation cues** are a conservative phrase list, at most one event per kind per tick, at intensity 0.5. The owner's turns can carry praise or rejection. The agent's own turns can carry collab, hobby, novelty, success or failure. `innerLife.episodeCueSkip` (e.g. `["success"]`) lists kinds that chat may never fire: set it when the host reports the real event through `brain_inner event` or `inner:<kind>` tags, so an agent describing its work ("the last thing I shipped...") is not credited twice. Explicit events and memory tags are unaffected.
- **`innerLife.excludeAgents`:** agent ids that skip the inner-life layer (no tick, header, wants, or events). Memory tools are unaffected. Use this for a non-crew agent who shares the service but should stay out of town inner life (e.g. `["mila"]`).
- **Sleep** restores Rest, spends the phasic burst, and lapses wants the layer generated from a low need once they are older than 7 days. Wants the agent wrote do not lapse (see Continuity below). Sleep also folds the day's away notes, reads bonds and writes the recent mood weather.

## Turn header

Each turn gets at most 3 state lines, plus at most 2 continuity lines that appear only when they have something to say (see Continuity below). They appear in local mode (`buildSelfModelHeader`) and on the service: `brain_turn_context` returns them as `inner` and also at the head of `text`, so hosts that already render the turn-context text show them without an update.

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
- `wants {items}`: add a whole list in one call. Each item is a string or `{what, why?, cost?, cost_hours?, need?, tags?}`. Items that match an open want, or an earlier item in the list, are skipped (the match ignores case, punctuation and spacing).
- `touch {want_id, why?}`: "I am still on this." Restarts the reminder clock for an own want and can rewrite its why.
- `away {hours?, moved?, note?}`: keep a short note about time away. `moved` is two or three short things that changed.
- `bond {who, what?, valence?, line?, remove?}`: a thread with one person. `what` logs an exchange, `line` sets the one-line description, `remove: true` forgets the bond.

## Config

```json
{ "innerLife": { "enabled": true, "header": true, "autoWants": true, "traits": ["curious"], "traitsByAgent": { "main": ["curious", "steady"], "algen": ["sharp", "petty"] }, "needRates": { "social": 0.5 },
  "headerExtraLines": 2, "wantResurface": { "firstHours": 24 }, "away": { "minHours": 4 }, "weather": { "days": 3 }, "bonds": { "recentDays": 7 } } }
```

On xanima-server the brain config is shared by every brain, so per-agent traits go in `brain.innerLife.traitsByAgent` in the service `config.json`, keyed by brain id (Tripp's brain is `main`); a restart picks them up.

The layer is **off by default**. `"innerLife": true` turns it on with the defaults. An object turns it on too, since writing the block is opting in: `{ "innerLife": { "traitsByAgent": { ... } } }` is on, and only `"enabled": false` inside the object turns it back off. With no `innerLife` key, or with `"innerLife": false`, there are no ticks, no header, and the tool refuses. The tables stay, unused.

## Continuity (schema v31)

Four additions about carrying something from one wake to the next. Each is on once the layer is on, and each has its own off switch. All of them are records and functional states, the same as the rest of the layer.

### Wants that persist

A want the agent wrote stays open until it is done or dropped. Only wants the layer generated from a low need (`source` starting with `need:`) lapse after 7 days.

An own want that sits untouched comes back in the header on a widening schedule: after 24 hours, then 2 days after that reminder, then 4 days, doubling up to a 30-day cap. The line carries the why:

```
[inner] still wanting, untouched 25h: Paint the gate (why: it has been bare since spring; cost ~2h) · back in ~2d unless touched · 3fa1c2d9
```

- At most one reminder (for any want) every 6 hours, most neglected want first. A list of thirty imported wants is spread out, not shown all at once.
- The want already on the "top want" line is not repeated.
- `touch` restarts the clock and the schedule. `done` and `drop` end it.
- A reminder that did not fit in the header this turn is not counted, so it is still due on the next turn.

Config: `wantResurface: false`, or `{ firstHours: 24, factor: 2, maxDays: 30, minGapHours: 6 }`.

### Away notes

A short note about a gap, stored as an episodic memory with low importance (0.25), so it can be recalled later like any other memory and fades like one.

- **From the host:** `brain_inner away {hours: 9, moved: ["the bakery reopened", "a record was left on the porch"]}` stores `Away about 9 hours. While I was gone: the bakery reopened; a record was left on the porch.` The host writes the words. `note` takes a free line instead of a list.
- **Only past a threshold:** nothing is stored for a gap under `away.minHours` (default 4). Without `hours`, the brain uses the gap it measured between two turn headers.
- **Brain-only fallback:** when a turn header is built after a gap and no note has been handed in, the brain writes a minimal one from its own records: promises that came due, where the mood ladder went, states that set in or wore off, wants that lapsed, sleep. At most three items. When nothing moved it writes nothing. A host note that arrives within 30 minutes replaces the brain's own note for that return (same memory, no second note).
- **Header:** on the turn it lands (for 10 minutes) the note shows as `[inner] back after ~9h away: the bakery reopened; a record was left on the porch`.
- **Sleep:** every calendar day (UTC) with two or more loose notes is folded into one memory (`Away 3 times on 2026-11-02, about 14 hours in all. What moved: ...`). The folded notes stay as superseded history.

Config: `away: false`, or `{ minHours: 4, auto: true, importance: 0.25 }`. `auto: false` turns off the brain-only fallback.

### Recent mood weather

At sleep the brain writes one or two plain sentences about the last 3 days. There is no model call: the sentence is a template filled from the data.

- The **shape** comes from the mood ladder: where it is now and whether it dipped or rose in the window (the `mood` rows in `inner_events`).
- The **content** comes from moodlets that lasted at least 2 hours in the window, longest first, each with its own reason. One state that has a reason of its own always leads, so the sentence is not only need words.
- Reasons are used as written. A reason that is a quoted chat snippet, or an event logged without a reason, is left out and only the word is used ("proud").

```
The last few days have been good: proud (shipped the walk clip) and inspired from talking with a friend.
There was a rough patch on Tuesday: frustrated about the bridge build failing and lonely. It has lifted since: proud (shipped the walk clip).
It has been a low few days: frustrated about the bridge build failing and lonely. One bright spot: inspired from talking with a friend.
```

When no state lasted and the ladder did not move, nothing is written. The last 7 entries are kept. The newest shows in the header as `[inner] lately: ...` while it is under 48 hours old.

Config: `weather: false`, or `{ days: 3, keep: 7 }`.

### Bonds

One item per person: who, a running one-line description the agent sets, the exchanges that moved it, and a direction derived from those exchanges.

- **Explicit events come first.** `brain_inner bond {who: "Ines", what: "she left a record on the porch", valence: 0.7}` logs an exchange. Valence runs from -1 to 1 and defaults to 0.5, an ordinary good exchange. `line` sets the description. The first call for a person creates the bond. Bonds are never created by inference.
- **Direction** is derived on read, from the exchanges and nothing else:
  - *warming*: the last 7 days add up to +0.75 or more (two ordinary good exchanges, or one that mattered);
  - *cooling*: they add up to -0.5 or less, or there has been no contact for 21 days;
  - *steady*: otherwise.
  Status shows the reason next to it, for example `warming (2 exchanges in 7d, net +1.2)` or `cooling (quiet for 22d)`.
- **Relatedness:** an explicit good exchange feeds Relatedness by 0.15 × valence, at most 0.3 per bond per day. A bad one costs 0.1 × its size. At sleep each warming bond adds 0.05, up to 0.15 in total.
- **Sleep, conservatively:** for a known bond with no explicit exchange since the last sleep, a memory written in that time that names the person and has `|emotional_weight| >= 0.35` counts as one weak exchange (±0.3). Failing that, 3 or more turns naming the person count as contact with valence 0: this keeps the bond from reading as gone quiet and never warms it. At most one inferred entry per bond per sleep.
- **Header:** when this turn's text names the person (whole word, any case), one line: `[inner] bond · Ines (warming): we keep trading records and honest notes · last: she left a record on the porch, 2d ago`. On the service the turn text is the `query` of `brain_turn_context`. In local mode the host passes `turnText` to `buildSelfModelHeader`.

The last 30 exchanges per bond are kept, and there can be at most 50 bonds.

Config: `bonds: false`, or `{ recentDays: 7, coolAfterDays: 21, mentionMin: 3 }`.

### Header budget

The continuity lines share at most `headerExtraLines` (default 2) lines per turn, on top of the 3 state lines:

1. one timely line: back-from-away, else a bond named in this turn, else an own want that is due;
2. the recent weather.

With no weather to show, a second timely line may take that place. With `headerExtraLines: 1` the timely line wins. `headerExtraLines: 0` hides all four and the features keep working underneath.

### What a host has to do

| Feature | Without host changes | With host changes |
|---|---|---|
| Wants | Reminders and the no-lapse rule work once the brain is on v31. | Call `brain_inner wants` once to move a wishlist in. |
| Away notes | The brain writes its own minimal note after a gap of 4 hours between turn headers. | Call `brain_inner away` with `hours` and `moved` when the agent comes back, before or within 30 minutes after its first turn. |
| Weather | Written at each sleep, shown in the header. | Nothing. |
| Bonds | Nothing happens until a bond exists. | Call `brain_inner bond` when two agents trade, help or clash. Pass the turn text so the header line can show. |

## Schema v29 (additive)

The migration adds the tables `inner_state`, `inner_needs`, `inner_moodlets`, `inner_wants`, `inner_events` and `inner_incentives`. Nothing existing is altered. A brain's inner state starts on its first tick after migration and does not replay history from before that point. `brain_reset` clears these tables.

## Schema v30 (additive)

Two columns on `inner_state`: `mood_state` (default `okay`) and `mood_state_at`. Existing brains start on Okay and walk from there one rung per tick.

## Schema v31 (additive)

Columns: `inner_wants.touched_at`, `last_surfaced_at`, `surface_count`; `inner_state.last_turn_at`, `away_from`, `away_seen_at`, `last_sleep_at`. New tables: `inner_away_notes`, `inner_weather`, `inner_bonds`, `inner_bond_events`. Nothing existing is altered. `brain_reset` clears the new tables.

On a brain that already has open wants written by the agent, those wants no longer lapse, and the ones older than a day become due for a reminder. They come back one at a time, at most one every 6 hours.
