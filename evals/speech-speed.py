#!/usr/bin/env python3
"""Measures the shipped speech programs on this machine: Pocket TTS, and whisper.cpp on the CPU.

    speech-speed.py --models-dir DIR --out DIR

Uses synthetic speech and generated silence. That's enough for speed and for silence hallucinations,
but says nothing about accuracy on real learners.
"""
import argparse
import json
import re
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
POCKET = next((ROOT / "sidecars/pocket-tts").glob("*/pocket-tts"))
WHISPER = next((ROOT / "sidecars/whisper").glob("*/whisper-cli"))

SENTENCES = [
    "Schön, dich kennenzulernen! Woher kommst du?",
    "Mein Hund wollte heute Morgen nicht nach Hause gehen.",
    "Ich finde es toll, dass du jeden Tag übst, auch wenn es manchmal schwer ist.",
]
MODELS = ["ggml-base-q5_1.bin", "ggml-small-q5_1.bin", "ggml-large-v3-turbo-q5_0.bin"]
THREADS = [4, 8]
SILENCES = {
    "silence": "anullsrc=r=16000:cl=mono",
    "room noise": "anoisesrc=r=16000:c=pink:a=0.003",
    "louder noise": "anoisesrc=r=16000:c=pink:a=0.03",
}


def seconds_of(wav: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(wav)],
        capture_output=True, text=True, check=True,
    )
    return float(out.stdout)


def transcribe(model: Path, wav: Path, threads: int) -> tuple[str, float]:
    started = time.perf_counter()
    out = subprocess.run(
        [str(WHISPER), "-m", str(model), "-f", str(wav), "-l", "de", "-t", str(threads), "-nt", "-np"],
        capture_output=True, text=True, check=True,
    )
    return " ".join(out.stdout.split()), time.perf_counter() - started


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--models-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    report: dict = {"pocket_tts": [], "whisper": [], "hallucinations": []}

    print("== Pocket TTS binary (each run reloads the model)")
    wavs = []
    for index, sentence in enumerate(SENTENCES):
        wav = args.out / f"speech{index}.wav"
        started = time.perf_counter()
        subprocess.run(
            [str(POCKET), "generate", "--language", "german", "--voice", "juergen", "--text", sentence,
             "--output-path", str(wav), "--quiet"],
            capture_output=True, check=True,
        )
        took = time.perf_counter() - started
        audio = seconds_of(wav)
        wavs.append((wav, audio, sentence))
        report["pocket_tts"].append({"audio_s": round(audio, 2), "total_s": round(took, 2)})
        print(f"  {audio:.1f} s of audio in {took:.2f} s, including load")

    for name, source in SILENCES.items():
        wav = args.out / f"{name.replace(' ', '_')}.wav"
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", source, "-t", "8", "-ar", "16000", "-ac", "1", str(wav)],
            check=True,
        )

    for model_name in MODELS:
        model = args.models_dir / model_name
        print(f"== {model_name}")
        for threads in THREADS:
            total_audio = total_time = 0.0
            for wav, audio, sentence in wavs:
                text, took = transcribe(model, wav, threads)
                total_audio += audio
                total_time += took
                if threads == THREADS[-1]:
                    print(f"  heard: {text}")
                    report["whisper"].append({"model": model_name, "said": sentence, "heard": text})
            print(f"  {threads} threads: {total_audio:.1f} s of speech took {total_time:.1f} s, including load")
            report["whisper"].append({"model": model_name, "threads": threads, "audio_s": round(total_audio, 1), "total_s": round(total_time, 1)})
        for name in SILENCES:
            for attempt in range(1, 3):
                text, _ = transcribe(model, args.out / f"{name.replace(' ', '_')}.wav", THREADS[-1])
                print(f"  {name} ({attempt}): {text!r}")
                report["hallucinations"].append({"model": model_name, "input": name, "heard": text})
                break

    (args.out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
