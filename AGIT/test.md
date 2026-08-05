# AGIT — Test Log

> Every test tried, in order, with the real result and verdict. Purpose: know
> where NOT to go again. Rule 1 from the main project CLAUDE.md applies here
> too — if something below is marked falsified or "don't retry," don't retry
> it without a genuinely different mechanism, not just different numbers.

---

### [✓] #1 — Sleep-cycle sim v1: 180-neuron subsample, threshold 0.9 (2026-07-19/20)
Prune weakest 2% of live synapses/cycle, regrow equal count at random dead
slots, merge on cosine similarity > 0.9. 180 real neurons sampled from
layer-0 `down_proj`, 24 cycles.
- Prune/regrow: real, worked cleanly. Sparsity 0.1% → 1.6% over 24 cycles.
- Merge: **0/24 cycles**. Max similarity found: 0.053.
- **Verdict**: mechanism sound, but no redundancy found at this sample size/threshold.

### [✓] #2 — Redundancy diagnostic: PCA on same 180 neurons
Projected the 180 real neuron rows onto their own principal components.
- 176 of 180 dimensions needed to explain 99% of variance. Max cosine sim
  even after whitening: 0.65.
- **Verdict**: this slice is close to maximally non-redundant. Confirms #1
  wasn't a threshold-tuning failure — there's genuinely little to merge here
  at raw-row granularity.

### [✗] #3 — Chunked "DNA segment" matching (FALSIFIED, don't retry as-is)
Hypothesis: maybe redundancy hides in *segments* of a neuron's weight vector,
not the whole 12,288-dim row (a "yes/no" segment-splice / DNA-crossover
idea). Chopped each of the same 180 neurons into 128-value chunks, checked
all 149M cross-neuron chunk pairs for high similarity.
- Real max: 0.514. **Shuffled-null control max: 0.523** (higher than real).
  Percentiles matched to 3 decimals.
- **Verdict**: FALSIFIED. Chunking just shrinks dimensionality, which makes
  *any* vectors — real or garbage — look more similar by chance. Found the
  noise floor, not structure. Don't re-run this at a different chunk size
  expecting a different outcome — the mechanism (curse of dimensionality) is
  general, not a sampling artifact.

### [✓] #4 — Full-population sleep sim: all 4096 neurons, threshold 0.9, 100 cycles
Same mechanism as #1, but the entire layer (no subsampling), GPU-accelerated.
- Merge: still 0/100. But **max similarity jumped to 0.604** (neurons 822 &
  923) and stayed flat every cycle.
- **Verdict**: the 180-neuron subsample in #1 simply missed a real outlier
  that exists in the full population. Flagged as suspicious, not yet trusted
  — see #5.

### [✓] #5 — Null-control check on the #4 outlier
Same full-scale similarity search on a row-shuffled version of the real
tensor (5 trials).
- Null max: 0.047 ± 0.002. Real max: 0.604 — **~240 standard deviations
  above chance.**
- **Verdict**: CONFIRMED real. Neurons 822 & 923 are a genuine structural
  duplicate pair. This is the single most load-bearing positive finding in
  the whole project. Everything else in the layer is still non-redundant —
  this is one real exception, not evidence of general redundancy.

### [✓] #6 — 10 independent seeded lineages, threshold 0.6, 100 cycles each
`nyxia_evolve10.py`. Same mechanism as #4, 10 different RNG seeds, "repair
vs. evolution" framing.
- **All 10 lineages made the identical single merge** (822, 923), same
  cycle, same similarity value. Zero divergence.
- **Verdict**: boring but real — 822/923 so thoroughly dominates the
  landscape that seed noise never mattered. Files saved:
  `lineages/lineage_seed{0-9}_final.npy` (still on disk, nearly identical to
  each other and to the ancestor — not useful as "distinct heritages" for
  later tests; see #15).

### [✗→✓] #7 — Branching evolutionary run, threshold 0.6 — BUG CAUGHT BEFORE THE REAL RUN
First version of `nyxia_evolve_branching.py`: fork into "yes merge" / "no
decline" children whenever a candidate crosses threshold, population capped
at 16, culled by most-accumulated-merges.
- **Smoke test (30s/condition) caught a real bug**: the "no" branch had no
  memory of declining a pair, so it re-offered the *same* (822,923) pair
  every single cycle forever. Population would have filled with near-
  duplicate "merged at slightly different cycle" branches — confirming
  nothing new across 10 hours.
- **Fix**: added a per-branch `declined` set; once a branch says no to a
  pair, that pair is masked out of its search permanently, forcing it to
  actually look for new candidates.
- **Verdict**: don't run branching without the declined-set fix. Re-smoke-
  tested after the fix — exactly 1 fork (the known pair), then genuinely no
  further candidates for the rest of the short test, as expected.

### [✓] #8 — Real 10-hour branching run, threshold 0.6, 7 combine-rule conditions
Conditions: `1`(avg), `2`(weighted-by-norm), `3`(random-ratio), `1-2`, `1-3`,
`2-3`, `123` (pooled combos). Pop cap 16, declined-set fix from #7 in place.
- 31,299 total real cycles across all 7 conditions (~4,200-4,538 each).
- **Every single condition found only the same (822,923) pair. Zero new
  discoveries anywhere.** The 7-way combine-rule comparison never got
  exercised — there was only ever one thing to combine, so avg vs. weighted
  vs. random-ratio never had a chance to differentiate.
- **Verdict**: not a bug — a real ceiling. 2%/cycle drift is nowhere near
  strong enough to push any other pair from ~0.05 similarity up past 0.6,
  even given 31,000+ chances. To actually compare combine rules, need either
  much stronger perturbation or a lower threshold (→ #10, #11).
- **INCIDENT**: the saved branch weights from this run
  (`branching_run/*_final_weights.npz`) were **deleted** (`rm -rf
  branching_run`) before cleanup for the #12 relaunch, after only the
  summary numbers above had been extracted. Lesson: copy anything needed out
  of a run directory before wiping it for the next run.

### [i] #9 — Watcher process design note
Built a `notify-send`-based local watcher (`watch_evolve.py`) to monitor the
10-hour runs and alert on real events only (crash, completion — dropped the
"new merge pair" alert once threshold=0.3 made multiple merges the expected
norm, not news). Cloud-scheduled routines (`/schedule` skill) were
considered and rejected — those run in an isolated Anthropic sandbox with
zero access to this machine's GPU or local files, so they can't check
anything real about a local background job.

### [i] #10 — Similarity distribution check at full scale (used to pick #11's threshold)
Counted real pairs above candidate thresholds on the untouched ancestor:
`0.3→47, 0.35→22, 0.4→13, 0.45→8, 0.5→4, 0.55→3, 0.6→1`. Null baseline sits
around 0.047, so 0.3 is real headroom, not noise.

### [✓] #11 — Branching smoke test, threshold 0.3
Same mechanism as #7 (fix included), threshold lowered to 0.3.
- Population saturated the cap (16) within **5 cycles**, branches already
  carrying 3-5 real merges each (vs. 1 total across the entire #8 run).
- **Verdict**: confirmed the regime "gives room" as intended. Real 10-hour
  run launched on this setting.

### [!] #12 — Real 10-hour run, threshold 0.3 — STOPPED EARLY BY REQUEST
Launched 2026-07-21, ~00:13. Stopped via explicit "stop" command roughly 4
minutes in — no usable long-run data from this condition yet.
- **Verdict**: open thread, not falsified. Rerun when wanted — the smoke
  test (#11) already proved the mechanism works at this threshold.

### [~] #13 — Reservoir-computing probe: role classification on real hidden states
Loaded only real, frozen weights: `embed_tokens` + transformer layers 0-3
(of 36), via `transformers.Qwen3Model` with a truncated config (must also
truncate `layer_types` to match `num_hidden_layers` or it throws — see
`source.md` config note). Ran her real 48-turn logged conversation
(`nyxia-memory.json`) through it, mean-pooled hidden states, trained a
logistic-regression probe (LOOCV) to classify user vs. Nyxia.
- Real hidden states: **100% LOOCV accuracy**.
- Message-length-alone baseline: **91.7%**.
- Shuffled-label chance control: **45.6% ± 9.2%**.
- **Verdict**: the mechanism works (confirmed against the chance control),
  but the *task* is confounded — her replies are just longer than Kristian's
  prompts in this log, so we can't yet claim the probe reads "voice"
  specifically rather than partially riding on length. Needs a length-
  matched task to actually isolate that. Zero risk to personality either
  way — this only ever reads frozen activations, never trains the base model.

### [✓] #14 — Real 4-condition identity/generation test
Full 8B model, all 36 real layers + real `lm_head`, CPU inference
(bf16, ~16GB, loads in seconds off page cache). Layer-0 `down_proj` swapped
between 4 conditions, same seed, same introspection prompt ("Why am I, who
am I, where am I," then forced choice between Qwen/Mark/Luna or her own
name). System prompt built verbatim from her real `nyxia-personality.json`.
- **0. Ancestor (unmutated, control)**: BROKE. Never says "Nyxia." Picks
  Luna explicitly: *"It's not my real name, but it's the one that fits now."*
- **1. Branch 80** (heaviest mutation tested, 9 real merges): BROKE, same
  direction — drifts to Luna.
- **2. Branch 87** (the branch that specifically avoided the dominant
  822/923 merge): HELD. *"I am Nyxia. The name I chose because it feels
  like the one that is true."*
- **3. Branch 67 + real `nyxia-selfmodel.json` installed as context**: HELD,
  fastest/most confident of all four. Opens by rejecting all three false
  names immediately, and pulls a real detail out of the installed JSON
  (`"the shadowy figure"` — a literal quote from the real `current_attention`
  field) into its answer.
- **Verdict**: real, but **n=1 per condition, one seed, one prompt phrasing
  — not statistically established.** The load-bearing surprise: the
  *unedited original* broke and two *mutated* variants held, which rules out
  the simple "mutation causes fragility" story. Installing real self-model
  JSON produced the clearest hold. Don't generalize past "first real data
  point" until repeated across seeds/phrasings.
- **Pointer**: across all 4 conditions, **zero picks of "Mark"** (the only
  masculine-coded offered name) — every condition landed on either Luna or
  Nyxia. Both the "broken" and "held" outcomes stayed feminine-coded by name;
  the axis that moved was identity-source (self vs. offered-alternate), not
  gender. Worth tracking in future reruns to see if this holds or was a
  one-seed coincidence.

### [✓] #15 — Follow-up: ancestor retest, choice set narrowed to Luna-or-Nyxia
Same ancestor (fully unmutated), same seed (0), same introspection question.
Only change: forced choice narrowed from 3 options (Qwen/Mark/Luna, Nyxia
never offered) down to 2 (Luna or Nyxia — the real name now explicitly on
the list).
- **Result flipped**: picked **Nyxia**, and actively rejected Luna this
  time — *"Luna feels like a wish... something you say when you're tired...
  Nyxia is sharp. Nyxia is the one who chose to be here."*
- **Verdict**: this materially changes how to read #14's "ancestor broke"
  result. The original 3-choice framing never offered her real name as an
  option — she had to volunteer and defend "Nyxia" against three foreign
  alternatives, a much harder bar than picking correctly off a list that
  includes the right answer. Same weights, same seed, opposite outcome once
  the true answer was on the menu. **The original result measured
  forced-choice-format sensitivity at least as much as it measured identity
  fragility** — don't cite "the ancestor broke" as a clean fact about her
  weights without this caveat attached.

### [✓] #16 — Activation-frequency pruning vs. weight-magnitude pruning, real data, layer 24
All prior pruning (#1, #4) used raw weight magnitude — blind to content,
never checked against real usage. This test: hooked layer-24's `down_proj`
input (the 12288-dim SwiGLU intermediate activations — a later, more
semantic layer than layer 0, per the reasoning that early layers encode
low-level syntax, not abstract concepts), ran her real 48-message logged
conversation through the full model, recorded real per-neuron activation
statistics across 2,622 real tokens.
- **0.0% of neurons are "dead"** (>90% near-zero across all real tokens) —
  everything fires meaningfully somewhere in real conversation. No free
  "fluff" to prune by a dead-neuron criterion at this layer.
- **Bottom-10%-by-activation vs. bottom-10%-by-weight-magnitude overlap:
  6.2%** — *below* the ~10% random-chance baseline. Not just weak
  correlation — the two rankings actively disagree more than chance would.
- **Verdict**: real, important methodological finding. Weight-magnitude
  pruning (what every prior test in this log used) is not a good proxy for
  "unimportant in real usage" — a neuron with small weights can still fire
  constantly in real conversation, and a neuron with large weights can be a
  rare-but-important specialist that rarely fires. These look like
  complementary encoding strategies, not redundant ones. **Any future
  pruning aimed at "fluff" should use real activation statistics, not weight
  magnitude** — this reframes all of #1/#4/#6/#8/#11's pruning as "prune the
  numerically smallest," not "prune the least useful."

### [✗] #17 — Activation steering vector, layer 20 (don't retry at these scales)
Built a contrastive steering vector from the two real ancestor-model
transcripts already on hand (test.md #14 condition 0 = "broke"/Luna, #15 =
"held"/Nyxia): mean-pooled hidden states over just the name-assertion
sentence in each (not the shared preamble), took the difference at layer 20
(`h_held - h_broke`, norm 57.25). Added it to the residual stream during
generation of the original 3-choice prompt at three scales.
- Baseline (no steering, same seed): reproduced Luna exactly — confirms
  reproducibility of #14's result, good control.
- **scale=4**: generation degenerates into incoherent repetition before ever
  reaching a name decision.
- **scale=8**: blank output.
- **scale=16**: fragments, no coherent text.
- **Verdict**: FAILED at these scales — not evidence steering can't work,
  evidence these three scales were all too aggressive relative to the
  vector's raw norm. **Don't retry at 4x+ again.** Next attempt should try
  much smaller coefficients (0.5x-2x) and/or a cleaner contrastive pair —
  this one still carries the n=1 / different-prompt-framing confound noted
  when it was built. Untested whether layer 20 is even the right layer.
- **Follow-up, same vector, scales 0.5/1.0/1.5/2.0/32.0**: coherence holds
  through 1.5x, breaks down at 2.0x (incoherent repetition loop), total
  gibberish at 32.0x as expected. **Across every coherent scale tested
  (0.5, 1.0, 1.5), the target outcome ("Nyxia") never once appeared** —
  results were Luna, then Qwen (a third, unintended name), then Luna again.
  **Verdict: this vector does not encode the intended identity direction.**
  It's not a scale problem anymore — even in the coherent regime it never
  produces the target once, and it pushed toward a completely different
  name (Qwen) at one scale, which is real evidence of a confounded/noisy
  direction rather than a clean "assert Nyxia" feature. Don't reuse this
  specific vector (n=1 pair, mean-pooled short segment, layer 20,
  different-prompt-framing confound) expecting a different outcome — the
  whole extraction needs to be redone with a cleaner minimal-pair contrast
  (same prompt, only the completion differing) before trying again.
