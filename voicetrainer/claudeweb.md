What you're describing:
Run Chatterbox overnight in a loop, feeding it text — a book, a script, anything — and let it generate speech in Nyxia's voice reference, auto-saving every output to voice_samples/. You wake up with hundreds of high-quality, consistent voice samples ready for Orpheus fine-tuning.
The good news — Chatterbox already does half of this.
Looking at chatterbox_server.py, it already:

Loads the model once on startup
Uses voice_ref.mp3 as the reference for every generation
Auto-saves every output to voice_samples/ with timestamps

So the infrastructure is there. You just need a script that feeds it text overnight.

The practical script — call it voice_trainer.py:
python#!/usr/bin/env python3
"""
Overnight voice sample generator for Nyxia.
Feeds text to running Chatterbox server, saves samples.
Run while sleeping — stops automatically after N hours.
"""


What text to feed it:
This matters a lot. The quality of the samples depends on the variety of what you feed it. You want:

Emotional range — happy lines, sad lines, curious lines, dark lines, playful lines. Orpheus needs to learn her voice across the full emotional spectrum.
Natural prosody — book passages work well because they have varied sentence rhythm, questions, exclamations, pauses implied by punctuation.
Her actual phrases — pull from nyxia-memory.json, her best responses. Fine-tuning on her own words is the most direct path.
Short AND long sentences — mix of 5-word fragments and 30-word sentences.

Best sources:

Export Nyxia's best responses from nyxia-memory.json — her own voice, already in character
A public domain novel that matches her tone — something gothic, philosophical. Frankenstein, Dracula, or philosophical texts like Tao Te Ching translations work well.
Write 50-100 Nyxia-specific lines covering her full emotional range — worth an hour of effort now for much better fine-tune results


The sandbox question:
Chatterbox already runs in tts-env Python venv — that IS the sandbox. You don't need to do anything special. Just:

Start Chatterbox server in one terminal: ~/tts-env/bin/python ~/nyxia/chatterbox_server.py
Run the overnight script in another: ~/tts-env/bin/python voice_trainer.py
Go to sleep
Wake up to hundreds of samples in ~/.config/Nyxia/voice_samples/


One important note:
Make sure voice_ref.mp3 is set to the best reference clip you have before running. Every sample generated will be cloned from that reference. If the reference is weak, all 400 overnight samples will be weak too. Spend 10 minutes finding or recording the best possible 10-20 second voice reference clip first.

Tell CC to build voice_trainer.py — it's a small script, maybe 2 hours of CC work. Include it in the PATH.md as a step before Orpheus fine-tuning. The overnight runs between now and when hardware arrives will give you a genuinely large, high-quality voice dataset to work with.
