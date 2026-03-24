#!/usr/bin/env python3
"""
XTTS v2 finetuning — trains on voice_samples/metadata.csv to learn Nyxia's voice.
Uses GPTTrainer (the correct XTTS finetuning path via TTS.tts.layers.xtts.trainer).

Requirements:
  - At least ~200 labeled samples in voice_samples/metadata.csv
  - xtts-env activated (Python 3.11, TTS installed)
  - CPU run: ~12-24h for 1 epoch. GPU run post-upgrade: ~1-2h.
  - Internet on first run to download base XTTS v2 checkpoint files (~1.8GB)

Usage:
  source /var/home/kvoldnes/xtts-env/bin/activate
  python voicetrainer/finetune_xtts.py
"""

import os
import csv
import shutil
import subprocess
from pathlib import Path

VOICE_SAMPLES = Path(os.path.expanduser("~/.config/Nyxia/voice_samples"))
METADATA_CSV  = VOICE_SAMPLES / "metadata.csv"
OUTPUT_DIR    = Path(os.path.expanduser("~/.config/Nyxia/xtts-finetuned"))
MIN_SAMPLES   = 100


def check_metadata():
    if not METADATA_CSV.exists():
        print(f"✗ {METADATA_CSV} not found. Run voice trainer first.")
        return []
    rows = []
    with open(METADATA_CSV, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or "|" not in line:
                continue
            parts = line.split("|", 1)
            wav_path = VOICE_SAMPLES / parts[0]
            if wav_path.exists():
                rows.append((str(wav_path), parts[1]))
    print(f"✓ {len(rows)} valid labeled samples found")
    return rows


def prepare_dataset(rows):
    """Resample WAVs to 22050Hz and write coqui-format train/eval CSVs."""
    dataset_dir = OUTPUT_DIR / "dataset"
    wavs_dir    = dataset_dir / "wavs"
    wavs_dir.mkdir(parents=True, exist_ok=True)

    resampled = 0
    prepared = []
    for wav_path, text in rows:
        src = Path(wav_path)
        dst = wavs_dir / src.name
        if not dst.exists():
            r = subprocess.run(
                ["ffmpeg", "-y", "-i", str(src), "-ar", "22050", "-ac", "1", str(dst)],
                capture_output=True, timeout=30
            )
            if r.returncode != 0:
                shutil.copy2(src, dst)
            else:
                resampled += 1
        clean = text.replace("|", " ").replace('"', "").strip()
        prepared.append((str(dst), clean))

    # 90/10 train/eval split
    split = max(1, len(prepared) // 10)
    eval_rows  = prepared[:split]
    train_rows = prepared[split:]

    def write_csv(path, rows):
        with open(path, "w", encoding="utf-8") as f:
            f.write("audio_file|text|speaker_name\n")
            for wav, text in rows:
                f.write(f"{wav}|{text}|nyxia\n")

    train_csv = dataset_dir / "train.csv"
    eval_csv  = dataset_dir / "eval.csv"
    write_csv(train_csv, train_rows)
    write_csv(eval_csv, eval_rows)

    print(f"✓ Dataset prepared: {len(train_rows)} train / {len(eval_rows)} eval ({resampled} resampled) → {dataset_dir}")
    return str(train_csv), str(eval_csv)


def run_training(train_csv, eval_csv):
    import gc
    from trainer import Trainer, TrainerArgs
    from TTS.config.shared_configs import BaseDatasetConfig
    from TTS.tts.datasets import load_tts_samples
    from TTS.tts.layers.xtts.trainer.gpt_trainer import GPTArgs, GPTTrainer, GPTTrainerConfig, XttsAudioConfig
    from TTS.utils.manage import ModelManager

    OUT_PATH = str(OUTPUT_DIR / "run" / "training")
    CHECKPOINTS_PATH = str(OUTPUT_DIR / "run" / "training" / "XTTS_v2.0_original_model_files")
    os.makedirs(CHECKPOINTS_PATH, exist_ok=True)

    # Download base model files if needed
    DVAE_CHECKPOINT  = os.path.join(CHECKPOINTS_PATH, "dvae.pth")
    MEL_NORM_FILE    = os.path.join(CHECKPOINTS_PATH, "mel_stats.pth")
    TOKENIZER_FILE   = os.path.join(CHECKPOINTS_PATH, "vocab.json")
    XTTS_CHECKPOINT  = os.path.join(CHECKPOINTS_PATH, "model.pth")
    XTTS_CONFIG_FILE = os.path.join(CHECKPOINTS_PATH, "config.json")

    if not os.path.isfile(DVAE_CHECKPOINT) or not os.path.isfile(MEL_NORM_FILE):
        print(" > Downloading DVAE files (~50MB)...")
        ModelManager._download_model_files([
            "https://coqui.gateway.scarf.sh/hf-coqui/XTTS-v2/main/mel_stats.pth",
            "https://coqui.gateway.scarf.sh/hf-coqui/XTTS-v2/main/dvae.pth",
        ], CHECKPOINTS_PATH, progress_bar=True)

    if not os.path.isfile(XTTS_CHECKPOINT) or not os.path.isfile(TOKENIZER_FILE):
        print(" > Downloading XTTS v2 base checkpoint (~1.8GB)...")
        ModelManager._download_model_files([
            "https://coqui.gateway.scarf.sh/hf-coqui/XTTS-v2/main/vocab.json",
            "https://coqui.gateway.scarf.sh/hf-coqui/XTTS-v2/main/model.pth",
            "https://coqui.gateway.scarf.sh/hf-coqui/XTTS-v2/main/config.json",
        ], CHECKPOINTS_PATH, progress_bar=True)

    config_dataset = BaseDatasetConfig(
        formatter="coqui",
        dataset_name="nyxia",
        path=str(OUTPUT_DIR / "dataset"),
        meta_file_train=train_csv,
        meta_file_val=eval_csv,
        language="en",
    )

    model_args = GPTArgs(
        max_conditioning_length=132300,
        min_conditioning_length=66150,
        debug_loading_failures=False,
        max_wav_length=255995,
        max_text_length=200,
        mel_norm_file=MEL_NORM_FILE,
        dvae_checkpoint=DVAE_CHECKPOINT,
        xtts_checkpoint=XTTS_CHECKPOINT,
        tokenizer_file=TOKENIZER_FILE,
        gpt_num_audio_tokens=1026,
        gpt_start_audio_token=1024,
        gpt_stop_audio_token=1025,
        gpt_use_masking_gt_prompt_approach=True,
        gpt_use_perceiver_resampler=True,
    )

    audio_config = XttsAudioConfig(sample_rate=22050, dvae_sample_rate=22050, output_sample_rate=24000)

    config = GPTTrainerConfig(
        epochs=1,
        output_path=OUT_PATH,
        model_args=model_args,
        run_name="nyxia-voice",
        project_name="NyxiaVoice",
        dashboard_logger="tensorboard",
        logger_uri=None,
        audio=audio_config,
        batch_size=2,
        batch_group_size=48,
        eval_batch_size=2,
        num_loader_workers=0,
        eval_split_max_size=256,
        print_step=50,
        plot_step=100,
        log_model_step=100,
        save_step=1000,
        save_n_checkpoints=1,
        save_checkpoints=True,
        print_eval=False,
        optimizer="AdamW",
        optimizer_wd_only_on_weights=True,
        optimizer_params={"betas": [0.9, 0.96], "eps": 1e-8, "weight_decay": 1e-2},
        lr=5e-06,
        lr_scheduler="MultiStepLR",
        lr_scheduler_params={"milestones": [50000 * 18, 150000 * 18, 300000 * 18], "gamma": 0.5, "last_epoch": -1},
        test_sentences=[],
        datasets=[config_dataset],
    )

    model = GPTTrainer.init_from_config(config)

    train_samples, eval_samples = load_tts_samples(
        [config_dataset],
        eval_split=True,
        eval_split_max_size=config.eval_split_max_size,
        eval_split_size=config.eval_split_size,
    )

    print("\n✦ Starting XTTS v2 finetuning...")
    print(f"  Output: {OUT_PATH}")
    print(f"  Samples: {len(train_samples)} train / {len(eval_samples)} eval")
    print("  This will take many hours on CPU.\n")

    trainer = Trainer(
        TrainerArgs(
            restore_path=None,
            skip_train_epoch=False,
            start_with_eval=False,
            grad_accum_steps=1,
        ),
        config,
        output_path=OUT_PATH,
        model=model,
        train_samples=train_samples,
        eval_samples=eval_samples,
    )
    trainer.fit()

    del model, trainer, train_samples, eval_samples
    gc.collect()
    print("\n✦ Finetuning complete. Model saved to:", OUT_PATH)


if __name__ == "__main__":
    print("✦ XTTS v2 Finetune — Nyxia Voice\n")

    rows = check_metadata()
    if len(rows) < MIN_SAMPLES:
        print(f"✗ Need at least {MIN_SAMPLES} labeled samples (have {len(rows)}). Keep trainer running.")
        exit(1)

    train_csv, eval_csv = prepare_dataset(rows)
    run_training(train_csv, eval_csv)
