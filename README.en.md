# SlopLens

A **slop index** for your X timeline, computed inside your own browser.

High scores get a badge. Uncertain ones get a mark. Low-information ones get a grey
label. Truncated posts get a faint tick. **It never makes the verdict for you.**

Local rule engine. No server, no account, no telemetry. The optional deep check is
bring-your-own-key.

> 中文说明见 [README.md](README.md)。完整规格（阈值、判据、已知坑）在
> [`sloplens/README.md`](sloplens/README.md)。

---

## What it is not

- **Not an "AI detector."** It never says "this was written by AI." It says *how strong
  the detectable signals are*, and always shows its reasons.
- **It uploads nothing.** No backend, no key required, all scoring happens in the page.

## Why it works this way

A single post is 280 characters. That is not enough evidence for a yes/no verdict — any
tool claiming high accuracy on that budget will misfire often enough that you stop
trusting it.

So SlopLens steps back: **four tiers + reasons + adjustable thresholds.** You always see
why something was flagged, and you can always disagree.

## Install (developer mode)

The extension is not on any store yet — load it unpacked:

1. Open `chrome://extensions` (or `edge://extensions`)
2. Turn on **Developer mode**
3. **Load unpacked** → pick the `sloplens/` folder
4. Open x.com and scroll

## Tiers

The score is a **slop index**, 0–100, higher = more templated. It is *not* a quality score.

| Tier | Rule | What you see |
|---|---|---|
| **Slop** | slop index ≥ 70 | red badge; collapses in "collapse" mode, click to expand |
| **Uncertain** | 45–69 | yellow badge, **never collapses** |
| **Low info** | specificity ≤ threshold | grey-blue dashed badge, **never collapses** |
| **Normal** | none of the above | nothing |
| **Needs expand** | post is truncated by X | faint tick, no score |
| **Half-post** | author only posted the first half | faint tick, no score |

Collapsing requires **two** conditions: slop ≥ 70 **and** specificity ≤ 35. AI-written but
substantive → badge only. Human-written waffle → not collapsed either.

## Feedback protocol

Click a badge and you get three buttons. You never have to judge "does this look like AI":

| Your reaction | Click | Value |
|---|---|---|
| Obviously synthetic, you can name why | `This is AI` | positive sample |
| Concrete details, first-hand, colloquial | `This is human` | negative sample |
| **Feels off, can't say why** | `Can't tell` | ⭐ the most valuable |
| No reaction | click nothing | no data, no noise |

## Deep check (optional)

Disabled by default. Fill in any **OpenAI-compatible** endpoint in settings
(DeepSeek by default, or OpenAI / local Ollama / your own gateway), then hit "deep check".
It costs nothing unless you click it. It never changes the collapse decision — the model
can be wrong, and collapsing is a costly action.

Optionally it can send a handful of the samples *you* labelled as few-shot
(off by default, max 4 AI + 4 human, 160 chars each) — turning it on means
sending more than just the one post you clicked.

## Privacy

No network by default. The only outbound request is the deep check you trigger yourself;
it sends that one post's text to *your* endpoint with *your* key (plus, only if you opt in,
up to 8 of your own labelled samples). Keys are stored in
plaintext locally — use a dedicated, rate-limited key.

Full details: [PRIVACY.md](PRIVACY.md).

## Development

```bash
node tools/calibrate.mjs samples.json     # derive thresholds from your own labels
node test/run.mjs                         # engine regression, zero deps
node test/llm.test.mjs                    # LLM client, zero deps, starts a fake server
npm i -D jsdom && node test/dom.test.mjs  # DOM smoke test
python3 tools/make-icons.py               # regenerate icons (needs Pillow)
```

`engine.js` and `llm.js` deliberately avoid DOM and storage, so they run in Node as-is.

## Status

v0.10.0. Targets x.com only. The rule engine is pure text processing, so other sites
(Zhihu, etc.) are a DOM-adapter away — see the roadmap in
[`sloplens/README.md`](sloplens/README.md).

## Disclaimer

The output is a statistical signal, not a factual finding. Do not use it to publicly call
out an account, and do not use it as grounds for a report. It serves exactly one purpose:
**whether *you* want to read this post.**

## License

GNU General Public License v3.0 — see [LICENSE](LICENSE).

Copyright (C) 2026 SlopLens contributors.
