---
name: askberg
description: >
  Batch every blocking decision into ONE phone-answerable HTML form — a deep-sea
  survey where you dive from the light, easy calls at the surface down to the
  ship-sinkers in the abyss. Instead of dripping "approve?" prompts or stalling,
  askberg gathers the open gates (via markers, docs, git, and the agent's own
  deferral ledger), grades them, builds a self-contained form with the
  recommended pick pre-selected on each, and you answer anywhere — phone or
  desktop — then paste one plain-text block back, which the agent applies by ID.
  Transport is plain text, so it rides Telegram, a remote session, or a paste box
  with zero infrastructure. Triggers: "/askberg", "askberg", "decision form",
  "gate the decisions", "give me the form", "batch these questions", "what needs
  my decision", "open loops / blockers waiting for me", or whenever 4+ real gates
  pile up on a project.
---

# askberg — the deep-sea decision survey

**What you see is a fraction of what's below.** askberg turns the decisions
waiting for a human into a single dive: light, reversible calls at the sunlit
surface; the irreversible ship-sinkers down in the dark. You answer the whole
batch at once, on any device, and paste one block back.

askberg is **two halves**:
1. **Discovery** — find the open loops / blockers / decisions-waiting in a repo or
   a session (`scripts/discover.js` + the agent's judgement).
2. **Presentation** — render them as one self-contained, phone-answerable form
   (`assets/build-form.js` + the frozen engine), and apply the pasted-back answers.

## Why batch, not drip

Dripping one-at-a-time "approve?" prompts trains rubber-stamping — research on
coding-agent oversight found humans catch the bad action only ~9–26% of the time
in a wall of prompts. Stalling (blocking until the human is at the keyboard)
wastes the run. askberg is the third way: **collect every gate, keep executing on
safe defaults, let the human answer async, then apply the batch.** Because the
transport is plain text both ways, it needs no bot, webhook, or service — and the
gate is real for free: the run has no answers until they're pasted back, so the
missing data *is* the lock (not a "please ask me first" instruction a model can
rationalise past).

---

## When to reach for it

- **4+ real gates have piled up** on a project — auto-offer the form.
- The human types `/askberg` / "give me the decision form" / "what needs my call".
- **Start / end of a long autonomous run** — gather the forks into one review.

Not for a single quick fork mid-conversation — just ask inline. This is for
*batches*.

## What counts as a gate (grade before you add)

Only add a decision if it must genuinely wait for the human:

| Grade | Example | In the form? |
|---|---|---|
| Reversible + in-scope | edits, drafts, commits, format churn, staging-to-a-gate | **No** — just do it |
| Irreversible / outward | **send, publish/deploy, payment, credential, signature** | **Yes** — never on a default |
| A genuine fork that changes what gets built | which approach, which variant, pricing, kill-vs-keep | **Yes** |
| Trivial with a safe default | cadence flags, cosmetic picks | Fold into one "accept these defaults?" catch-all |

Nothing irreversible ever rides a default. Every fork gets a `recommended`
option with its rationale in `context` — that's the entire friction budget.

---

## Discovery — finding the gates

Run the collector to harvest candidates from the repo:

```
node scripts/discover.js            # scans cwd, writes .askberg/candidates.json
node scripts/discover.js --json     # prints candidates to stdout
```

It runs deterministic collectors (config in `.askberg.yml`, all optional):
- **markers** — greppable inline tags anyone can drop: `askberg:`, `DECISION:`,
  `@decision`, `BLOCKED:`, `TODO(decide)`, … (configurable, multiple supported).
- **docs** — decision-shaped headings/lines in planning/handoff/TODO/ADR files
  (*Pending, Blockers, Open questions, Awaiting, Needs decision*).
- **git** — uncommitted WIP, stranded branches (ahead *and* behind), and — if `gh`
  is present — open PRs with your review requested and issues assigned to you
  labelled `question`/`blocked`/`decision`.
- **ledger** — the agent's own `.askberg/ledger.md` of forks it deferred mid-run
  (append a row each time you take a reversible default: `[ID] · lane · question
  · default taken · what's provisional · stakes`).

Then **you (the agent) grade** the candidates into the decision schema: drop the
non-gates, write the `recommended` default + rationale, set stakes, cluster by
project. `discover.js` finds; the model judges. Each candidate keeps its
`source` + `file:line` for provenance.

**Close the loop (strike-on-answer):** when an answer comes back, mark its source
resolved — strike the marker / note the doc line done — so the same gate is never
re-asked. `scripts/discover.js --resolve <ID>` handles marker striking.

> Reuse note: much of the marker/doc/WIP scanning overlaps the `banana-hunt`
> skill (it already finds broken commitments, "Pending" items, and stale WIP).
> Prefer extending those scanners over reinventing them.

---

## Presentation — building the form

1. Write the graded decisions to `<project>/.planning/decisions/<slug>.questions.json`
   (schema below; path is configurable via `.askberg.yml`).
2. Build the self-contained form:
   ```
   node assets/build-form.js <slug>.questions.json <out>.html
   ```
   Write the `.html` to an explicit project path — **never** a bare filename or a
   Downloads folder.
3. Hand off in one line: *"Decision form ready — open `<path>` (phone or desktop),
   tick what you disagree with, hit Copy, paste the block back. Everything you
   skip takes the recommended default."* Keep executing reversible work meanwhile.
4. Apply what comes back (grammar below), then act, and strike the sources.

Answered forms are **disposable** — safe to purge from `.planning/decisions/`
after ~14 days.

### Decision object schema

```jsonc
{
  "id": "API-1",                    // stable, short, unique. The human references it.
  "cluster": "Platform",            // project group; cards sort by stakes within it
  "urgency": "red",                 // red = can sink us · amber = deeper · grey = shallow
  "question": "Which variant is canonical?",
  "context": "One or two sentences: the why + the recommended pick's reason.",
  "type": "single",                 // "single" (radio, default) | "multi" (checkboxes)
  "options": [
    { "value": "a", "label": "Ship variant A", "recommended": true, "desc": "optional" },
    { "value": "b", "label": "Hold for review", "desc": "optional" }
  ],
  "notesHint": "optional placeholder for the always-present note box"
}
```

Rules: exactly one `recommended:true` per `single` question. For a send/deploy/
signature, the recommended option is "draft/stage it + do it once I approve" — the
doing still waits behind the explicit answer. **Order questions surface → deep by
stakes; the engine also sorts by stakes within each project cluster.** Every card
gets a small note box, even A/B ones.

### The paste-back grammar

The form's "Generate answer block → Copy answers" emits exactly this:

```
DECISIONS <date> — <title>
(paste this whole block back to Claude)
====================================================

## <cluster>
[<ID>] <question>
   -> <chosen option label>  [default]      <- "[default]" = accepted the recommended
   notes: <free text>                        <- only if the human typed a note
```

To apply: for each `[ID]`, match the chosen `label` to its `option.value` and act.
`[default]` (or a missing `[ID]`) means the recommended value. Always honour
`notes` — for edit-style items (subject lines, pricing, wording) the note IS the
answer. Also accept **shorthand** — `all defaults`, or `API-1 v2a, REL-1 send,
rest defaults` — mapping the same way. If a note contradicts the picked option, the
note wins; if ambiguous, ask about that one item only.

---

## Look & feel

The form is a deep-sea instrument (see it, don't fight it): a submarine depth
gauge that climbs as you scroll (−m / bar / °C, bottoming out at Titanic's −3800 m),
real oceanographic zones (sunlight → twilight → midnight → abyssal), a crystalline
iceberg behind cream chart-paper "survey cards", a technical chart-frame, a
halftone ghost-leviathan in the deep, a seabed with a shipwreck + whale bones, and
a "surfacing" payoff on Copy (the berg calves with a splash, the sky clears to
sunset, a sailboat settles into calm water — *smooth sailing ahead*). Palette is
white / blue / orange (`#ff7000` on gold). **The engine is frozen — only the
questions JSON changes.** Change `assets/form-template.html` once and every future
form inherits it.

## Config (`.askberg.yml`, optional)

```yaml
markers: ["askberg:", "DECISION:", "@decision", "BLOCKED:"]
docPaths: [".planning", "TODO.md", "DECISIONS.md", "docs/adr"]
owner: "@me"                 # who "assigned to you" means for git/issues
outDir: ".planning/decisions"
cleanupDays: 14
```

Everything has a sensible default — the file is optional.

## Cross-platform

The engine is a plain HTML file with no dependencies, so it runs anywhere. The
skill wrapper is Claude-Code-shaped; use `skilldrill` to generate adapters for
Grok / Codex / Gemini / others.

## Files

- `assets/form-template.html` — the frozen deep-sea engine (theme-aware, mobile, no deps).
- `assets/build-form.js` — inject a questions JSON → one self-contained HTML form.
- `assets/example.questions.json` — a 3-item example that doubles as the schema.
- `scripts/discover.js` — the deterministic discovery collector.
- `.askberg.example.yml` — copy to `.askberg.yml` and edit to customise.
