# V2 Rebrand Token Layer

## What this PR adds

A single additive stylesheet (`assets/wellet-v2-tokens.css`) loaded **after the entire editorial-\* stack** on `index.html`, and on every standalone page (`how-it-works`, `privacy`, `support`, `terms`, `your-data`, `share`, `family-record`, `care_signals_preview`, `dsinvite`, `smoketest-wishes`).

Also adds Gambetta + Public Sans `<link>` tags alongside the existing Fraunces / DM Sans loads. Both font sets remain loaded — no replacement until each surface migrates.

**Nothing visible changes** until a surface opts in by using the new classes.

## Discipline (same as editorial-foundation.css)

This PR is plumbing only. It respects the editorial rollout pattern already in flight (`editorial-auth`, `editorial-updates`, `editorial-records`, etc.) — each surface migrates in its own PR, one at a time.

## Typography

- **Display**: Gambetta (Fontshare) — weights 300/400/500/400i
- **Body**: Public Sans (Google Fonts) — weights 400/500/600/700

Tokens expose `--font-v2-serif` and `--font-v2-sans` aliases.

## Color tokens (`--c-*`)

The V2 semantic palette:

- **Forest** (`--c-forest`, `--c-forest-deep`, `--c-forest-leaf`, `--c-forest-pine`) — primary brand
- **Mint** (`--c-mint`, `--c-mint-soft`, `--c-mint-deep`) — "fresh" status
- **Clay / Walnut / Clay-soft** — change states + self-reported provenance
- **Mist / Stone / Blue** — cool neutrals
- **Midnight** — depth accent, used sparingly
- **Alert** — ER red, used only in the ER surface

These coexist with the existing `--moss`, `--mint`, `--cream`, `--amber` tokens in `wellet.css`. No existing tokens are overridden.

## rcard primitives

- `.rcard` — Forest 3px left border + Clay eyebrow + Mint pill (V2 grammar)
- `.rcard.is-change` — Clay border (dose changed, etc.)
- `.rcard.is-unavailable` — Stone bg, dimmed
- `.rcard.with-icon` — 34px Mint-soft icon tile
- `.rc-eyebrow.self-reported` — Walnut + "flag for next visit"
- `.timeline-rail` — vertical rail with filled Forest dots
- `.btn-forest-outline` — demoted-CTA variant
- `.menu-tile`, `.menu-tile.is-emergency` — side-menu icon tiles

## Reference

V2 mockups: see the v2 reference site preview in the chief-of-staff thread for live examples of every primitive.

## Migration plan

Surfaces migrate **one at a time** in subsequent PRs, same discipline as the existing editorial rollout. This PR is plumbing only.
