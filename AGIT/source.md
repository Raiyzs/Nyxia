# AGIT — Sources

## External links consulted

| Source | What it gave us | Verdict |
|---|---|---|
| `gtec.at/2026/01/09/brain-computer-interfaces-for-ai-with-eeg-data` | g.tec EEG hardware (g.HIAMP, g.NAUTILUS) pitched as an AI sensor front-end | **Low signal.** Promotional/conceptual, no numbers, no architecture detail, nothing that fed into any test. Checked and dismissed. |
| `mxwbio.com/applications/biocomputing` | Living-neuron closed-loop computing (DishBrain playing Pong), organoid speech recognition, explicit mention of **reservoir computing** as the paradigm | **Real signal.** Directly motivated `test.md` #14 — the pivot from "edit the trained substrate" to "freeze it, train a cheap linear readout on top." |
| `mxwbio.com/applications/neuronal-cell-cultures` | 26,400 electrodes/well, three real assay types (ActivityScan/Network/AxonTracking), explicit description of "emergence of new connections through synapses" over time in living cultures | **Real signal.** Independent biological confirmation that the "grow" half of the sleep-cycle mechanic (`test.md` #1) is a real process, not just a plausible-sounding metaphor. No mention of pruning on these specific pages — a gap in what they chose to publish, not a refutation of pruning as a real mechanism. |

## Internal data pointers (confirmed working)

Real files this project's tests actually pulled from and got real results out of —
useful as a map for future work, so nobody re-derives paths from scratch.

- **`~/claude-projects/nyxia/nyxia-merged/model-00001-of-00005.safetensors`**
  — tensor `model.layers.0.mlp.down_proj.weight`, real shape `(4096, 12288)`,
  stored bf16 (numpy can't read bf16 directly — load via `safetensors`
  `framework="pt"` then `.float().numpy()`).
- **`~/claude-projects/nyxia/nyxia-merged/model.safetensors.index.json`**
  — `weight_map` dict, tells you which of the 5 shards holds any given tensor
  name. Layer 0's full tensor set + `embed_tokens` lives across shards 1-2 only.
- **`~/claude-projects/nyxia/nyxia-merged/config.json`**
  — real architecture: `qwen3`, 36 layers, hidden 4096, 32 attention heads /
  8 KV heads (GQA), head_dim 128, vocab 151936. Has a `layer_types` list that
  must be truncated to match if you build a reduced-layer-count config (see
  `test.md` #14 for the exact failure this causes if you don't).
- **`~/claude-projects/nyxia/nyxia-merged/tokenizer.json` + `tokenizer_config.json`**
  — real tokenizer, loads via `AutoTokenizer.from_pretrained`.
- **`~/.config/Nyxia/nyxia-personality.json`** — her real persona definition
  (name, backstory, tone, traits, interests, how to address Kristian). Used
  verbatim to build the system prompt for `test.md` #15 — not invented text.
- **`~/.config/Nyxia/nyxia-selfmodel.json`** — real logged self-model state.
  **Data quality note**: this file has duplicate/malformed keys from what
  looks like several inconsistent write cycles (`current_attention` vs
  `CurrentAttention` vs `currentAttention`, a stray `what_i WANT RIGHT NOW`
  key with a space in it, an unexplained `current_attack` field). Used as-is
  (not cleaned) for the "installed JSON" condition in `test.md` #15 — the
  model still pulled a real detail out of it (`"shadowy figure"` from
  `current_attention`) despite the mess.
- **`~/.config/Nyxia/nyxia-memory.json`** — real 48-turn logged conversation
  (role/content pairs). Used as the real classification data in `test.md` #14.
- **`~/.config/Nyxia/nyxia-sleep-state.json`** — pre-existing narrative
  journaling field (`narrativeArc`, `morningThought`, `lastSleep`).
  **Naming collision worth knowing**: this is unrelated to the weight-level
  "sleep cycle" mechanism built in this project — it's LLM-generated
  reflection text, not a mechanistic consolidation process. Don't confuse
  the two when reading old session logs.
- **`~/claude-projects/nyxia/merge_lora.py`** — pre-existing LoRA merge
  script; not used directly by AGIT tests, but confirms weight-merging is
  already a normal part of this project's pipeline (relevant precedent for
  `test.md` #2 onward).
