#!/usr/bin/env python3
"""Builds a blind listening test comparing German voices, at normal and learner speed.

    build.py --voices-dir DIR --out DIR [--python PATH] [--pocket PATH]

Needs `piper` and `pocket-tts` installed in the given Python environment, plus ffmpeg on PATH.
Writes MP3 samples and an index.html that plays them under neutral labels and keeps ratings in
the browser. The voice names are only shown once the listener asks for the results.
"""
import argparse
import json
import random
import shutil
import subprocess
import time
from pathlib import Path

# Everyday lines at the levels the app speaks, including umlauts, ß, and a question.
SENTENCES = [
    "Schön, dich kennenzulernen! Woher kommst du?",
    "Oje, du bist zum Arzt gegangen? Was war denn los?",
    "Mein Hund wollte heute Morgen nicht nach Hause gehen.",
    "Warst du heute zu Hause, oder bist du noch rausgegangen?",
    "Ich finde es toll, dass du jeden Tag übst, auch wenn es manchmal schwer ist.",
]

SLOW_SPEED = 0.8
CALIBRATION_SCALES = (1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 2.0)

PIPER_VOICES = {
    "Piper kerstin (low)": "de_DE-kerstin-low",
    "Piper ramona (low)": "de_DE-ramona-low",
    "Piper eva_k (x_low)": "de_DE-eva_k-x_low",
    "Piper thorsten (medium)": "de_DE-thorsten-medium",
    "Piper thorsten (high)": "de_DE-thorsten-high",
    "Piper karlsson (low)": "de_DE-karlsson-low",
    "Piper pavoque (low)": "de_DE-pavoque-low",
    "Piper mls (medium)": "de_DE-mls-medium",
}

POCKET_VARIANTS = {
    "Pocket TTS juergen (german)": "german",
    "Pocket TTS juergen (german_24l)": "german_24l",
}


def run(*command: str, stdin: str | None = None) -> None:
    subprocess.run(command, input=stdin, text=True, check=True, capture_output=True)


def to_mp3(wav: Path, mp3: Path, tempo: float | None = None) -> None:
    filters = ["-filter:a", f"atempo={tempo}"] if tempo else []
    run("ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), *filters, "-b:a", "96k", str(mp3))


def duration_seconds(wav: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(wav)],
        capture_output=True, text=True, check=True,
    )
    return float(out.stdout.strip())


def write_page(path: Path, *, title, intro, clips, criteria, key, sentences, samples, labels) -> None:
    page = (Path(__file__).parent / "template.html").read_text(encoding="utf-8")
    for placeholder, value in {
        "__TITLE__": title,
        "__INTRO__": intro,
        "__KEY__": key,
        "__CLIPS__": json.dumps(clips, ensure_ascii=False),
        "__CRITERIA__": json.dumps(criteria, ensure_ascii=False),
        "__SENTENCES__": json.dumps(sentences, ensure_ascii=False),
        "__SAMPLES__": json.dumps(samples),
        "__LABELS__": json.dumps(labels, ensure_ascii=False),
    }.items():
        page = page.replace(placeholder, value)
    path.write_text(page, encoding="utf-8")


def calibrate_slow_scale(python: str, model_path: Path, work: Path) -> float:
    """Finds the length scale that really gives SLOW_SPEED: Piper's setting isn't linear, and differs by voice."""

    def seconds(scale: float) -> float:
        wav = work / f"calibration.{scale}.wav"
        run(python, "-I", "-m", "piper", "--model", str(model_path), "--length-scale", str(scale),
            "--output-file", str(wav), stdin=" ".join(SENTENCES))
        return duration_seconds(wav)

    target = seconds(1.0) / SLOW_SPEED
    return min(CALIBRATION_SCALES, key=lambda scale: abs(seconds(scale) - target))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--voices-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--python", default="python3")
    parser.add_argument("--pocket", default="pocket-tts")
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    work = args.out / "wav"
    work.mkdir(exist_ok=True)

    samples = []
    speed_report = {}

    def add(voice: str, sentence_index: int, wav: Path, seconds: float) -> None:
        stats = speed_report.setdefault(voice, {"audio": 0.0, "compute": 0.0})
        stats["audio"] += duration_seconds(wav)
        stats["compute"] += seconds

    for voice, model in PIPER_VOICES.items():
        slow_scale = calibrate_slow_scale(args.python, args.voices_dir / f"{model}.onnx", work)
        speed_report.setdefault(voice, {"audio": 0.0, "compute": 0.0})["slow_length_scale"] = slow_scale
        for index, sentence in enumerate(SENTENCES):
            for speed in (1.0, SLOW_SPEED):
                wav = work / f"{model}.{index}.{speed}.wav"
                started = time.perf_counter()
                # Piper changes speed in the model itself, so slow speech isn't time-stretched audio.
                length_scale = 1.0 if speed == 1.0 else slow_scale
                run(
                    args.python, "-I", "-m", "piper",
                    "--model", str(args.voices_dir / f"{model}.onnx"),
                    "--length-scale", str(length_scale),
                    "--output-file", str(wav),
                    stdin=sentence,
                )
                if speed == 1.0:
                    add(voice, index, wav, time.perf_counter() - started)
                samples.append({"voice": voice, "sentence": index, "speed": speed, "wav": wav})

    for voice, language in POCKET_VARIANTS.items():
        for index, sentence in enumerate(SENTENCES):
            wav = work / f"{language}.{index}.1.0.wav"
            started = time.perf_counter()
            run(args.pocket, "generate", "--language", language, "--voice", "juergen",
                "--text", sentence, "--output-path", str(wav), "--quiet")
            add(voice, index, wav, time.perf_counter() - started)
            samples.append({"voice": voice, "sentence": index, "speed": 1.0, "wav": wav})
            # Pocket TTS has no documented speed control, so slow speech is time-stretched, as the app would do it.
            samples.append({"voice": voice, "sentence": index, "speed": SLOW_SPEED, "wav": wav, "stretch": True})

    audio_dir = args.out / "audio"
    audio_dir.mkdir(exist_ok=True)
    random.seed(20261102)
    voices = list(PIPER_VOICES) + list(POCKET_VARIANTS)
    random.shuffle(voices)
    labels = {voice: f"Voice {chr(ord('A') + i)}" for i, voice in enumerate(voices)}

    manifest = []
    for sample in samples:
        name = f"{labels[sample['voice']].replace(' ', '')}-{sample['sentence']}-{int(sample['speed'] * 100)}.mp3"
        to_mp3(sample["wav"], audio_dir / name, SLOW_SPEED if sample.get("stretch") else None)
        manifest.append({"label": labels[sample["voice"]], "sentence": sample["sentence"], "speed": sample["speed"], "file": f"audio/{name}"})

    write_page(
        args.out / "index.html",
        title="Which voice would you want to talk to every day?",
        intro=(
            "Play each voice and rate it. The names stay hidden until the end, so you're judging only what you hear. "
            'Rate "Natural" for how pleasant and human it sounds, and "Clear" for how easy the German is to follow. '
            '"Slow" plays learner speed.'
        ),
        clips=[["▶ Normal", 1], ["▶ Slow", SLOW_SPEED]],
        criteria=[["natural", "Natural"], ["clear", "Clear"], ["slow", "Slow speed sounds OK"]],
        key="voice-test-ratings",
        sentences=SENTENCES,
        samples=manifest,
        labels={label: voice for voice, label in labels.items()},
    )
    shutil.rmtree(work)

    # Each sample is a fresh process that reloads the model, so these overstate real synthesis time.
    report = {
        v: {"audio_s": round(s["audio"], 1), "compute_s": round(s["compute"], 1), "slow_length_scale": s.get("slow_length_scale")}
        for v, s in speed_report.items()
    }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
