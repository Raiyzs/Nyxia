# AGIT — Project Overview

> Research thread testing brain-inspired mechanisms (sleep-cycle consolidation,
> merge/prune/grow, reservoir computing, evolutionary branching, identity
> stability) directly against Nyxia's real trained weights and real generation
> — not toy data, not simulation-only claims. Started 2026-07-19.

**Session**: https://claude.ai/code/session_012e2XNMTb4VuCkXHcWcYF1J
(tests #1-#17 in `test.md` were all produced in this one session)

---

## Scope

All weight-level work operates on **one tensor**: `model.layers.0.mlp.down_proj.weight`
(shape `4096 x 12288`, bf16 on disk) inside
`~/claude-projects/nyxia/nyxia-merged/model-00001-of-00005.safetensors`
(Qwen3 architecture, 36 layers, 8B params total). Layer 0 only — never the
whole model's weights, never the live production checkpoint in place. Every
mutation runs on an explicit, hashed, on-disk copy
(`AGIT`-adjacent scratch dir `lineages/ORIGINAL_ancestor_layer0_down_proj.npy`,
sha256 `a1de5eb9f1d415d4...`); nothing here has ever written back to the real
checkpoint.

The generation/identity tests (see `test.md` #15) go further — a full 8B model
load (all 36 layers + lm_head, CPU inference) with the layer-0 tensor swapped
in from a mutated variant, so real text can actually be generated and compared.

## Why this exists

Started from a question about whether AI's hardware cost vs. an organic
brain's efficiency is a math problem or a tech problem (it's mostly math —
backprop's requirements, not silicon). That led to testing specific
brain-inspired mechanisms for real, on Nyxia's real weights, instead of
staying theoretical:

1. **Sleep-cycle consolidation** — prune weak synapses, merge redundant
   neurons, regrow capacity. (`test.md` #1-#9)
2. **Reservoir computing** — freeze a substrate, read out with a cheap linear
   probe instead of retraining. (`test.md` #14)
3. **Evolutionary branching** — let independent lineages diverge at real
   decision points instead of converging back to a "repaired" state.
   (`test.md` #7-#9, #12-#13)
4. **Identity/persona stability under real generation** — does the persona
   hold or break when a real layer is mutated, with/without her real
   self-model data installed as context. (`test.md` #15)

## Current state (as of 2026-07-21)

- **Merging**: real, but rare. Layer 0 has exactly one strong outlier pair
  (neurons 822 & 923, cosine sim 0.604, ~240 std devs above the shuffled-null
  baseline of ~0.047) — confirmed real, confirmed structural, confirmed to
  dominate everything else in the layer at any threshold above ~0.5. Below
  0.5 there is real additional headroom (47 pairs above 0.3) not yet fully
  explored (the 10-hour run testing this was stopped early by request).
- **Pruning/regrowth**: works cleanly, vectorized, cheap (2% prune/regrow per
  cycle, need-weighted zero-init growth as a MoE-flavored proxy — not literal
  per-token routing, see `test.md` #9 note).
- **Reservoir probing**: mechanism works (100% LOOCV role-classification on
  4 real frozen layers), but the one task tried so far is confounded by a
  trivial baseline (message length gets 91.7% alone) — inconclusive on
  whether it captures voice specifically.
- **Identity stability**: real, but format-sensitive — the *unmutated
  original*, offered a 3-choice list that didn't include her own name
  (Qwen/Mark/Luna), broke and picked "Luna." Two mutated variants held under
  that same 3-choice format ("I am Nyxia"), and installing her real
  self-model JSON as context produced the fastest, most grounded hold.
  **But**: retested the same unmutated original, same seed, with the choice
  narrowed to just Luna-or-Nyxia (her real name now on the list) — she
  flipped to picking Nyxia and explicitly rejected Luna. So "the ancestor
  broke" is not a clean, weight-only fact — it's at least partly a forced-
  choice-format effect (not being offered the correct answer). The
  mutated-variant comparisons (branch 80 vs. 87 vs. 67+JSON) still stand
  since they all used the same 3-choice format as each other. n=1 per
  condition throughout — real data points, not yet a statistically
  established pattern.

## Open threads

- Rerun the threshold=0.3 evolutionary branching test for the full 10 hours
  (stopped early 2026-07-21, see `test.md` #13) — this is the only way to get
  a real multi-merge combine-rule comparison (avg vs. weighted vs.
  random-ratio), since threshold=0.6 never gave branches more than one merge
  to work with.
- Repeat the identity test across multiple seeds/prompt phrasings before
  treating "avoiding the dominant merge" or "installing self-model JSON" as
  a proven stabilizer.
- Fix the reservoir-probe confound: needs a task where length isn't
  correlated with the label.
- GGUF crossbreeding idea (splice two checkpoints) — never attempted, blocked
  on needing a GGUF tensor reader (`nyxia.gguf` / `nyxia-v2.gguf` are
  quantized, not safetensors).
- **Doc bugs found by `~/claude-projects/neuro-ai-research` (2026-07-24), not yet fixed:**
  this project's own cross-references to `test.md` test numbers are off by one
  from the file's current numbering (looks like `test.md` got renumbered at
  some point after these references were written, never fixed — e.g. this
  file's Scope section cites reservoir-computing as #14 and identity as #15;
  the current file has them at #13 and #14/#15 respectively). Also: the
  "~240 std devs above baseline" framing in test #5 is directionally right
  but overstates precision (5-sample std-dev estimate) — a rigorous
  Bonferroni-margin recomputation lands at ~61σ above a properly corrected
  significance threshold for the 8,386,560 comparisons involved, which is the
  more defensible number to cite. Fix both when this file is next touched for
  real work, not urgent on its own. Full derivation in
  `~/claude-projects/neuro-ai-research/research/phase1/02-generative-probability-math.md`
  §3.4 and `research/phase1/03-electroneurons-neuromorphic.md`'s opening note.
