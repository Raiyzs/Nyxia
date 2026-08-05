#!/usr/bin/env python3
"""Merge Nyxia LoRA adapter into Qwen3-8B base model."""

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel

BASE_MODEL = "Qwen/Qwen3-8B"
LORA_PATH  = "/home/kvoldnes/nyxia/Finetuned_Nyxia_qwen/orkspace/nyxia-lora/final"
OUTPUT     = "/home/kvoldnes/nyxia/nyxia-merged"

print(f"Device: {'cuda' if torch.cuda.is_available() else 'cpu'}")

print("Loading base model (BF16)...")
model = AutoModelForCausalLM.from_pretrained(
    BASE_MODEL,
    torch_dtype=torch.bfloat16,
    device_map="auto",
)
tokenizer = AutoTokenizer.from_pretrained(LORA_PATH)

print("Applying LoRA adapter...")
model = PeftModel.from_pretrained(model, LORA_PATH)

print("Merging weights...")
model = model.merge_and_unload()

print(f"Saving merged model to {OUTPUT} ...")
model.save_pretrained(OUTPUT, safe_serialization=True, max_shard_size="4GB")
tokenizer.save_pretrained(OUTPUT)
print("Done. Now run GGUF conversion.")
