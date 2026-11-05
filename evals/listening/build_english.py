#!/usr/bin/env python3
"""Blind listening test for the English partner's voice, using the shipped Pocket TTS binary.

    build_english.py --out DIR

Only male voices whose recordings allow use in an app: VCTK (CC BY 4.0), voice donations and
voice-zero (CC0). `jean` is left out because its EARS recordings are non-commercial only.
"""
import argparse
import random
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from build import to_mp3, write_page  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent.parent
POCKET = next((ROOT / "sidecars/pocket-tts").glob("*/pocket-tts"))
VOICES = ["charles", "paul", "george", "michael", "marius", "javert", "bill_boerst", "peter_yearsley", "stuart_bell"]
SENTENCES = [
    "Oh, that sounds brilliant! How did the interview go in the end?",
    "Honestly, I've been absolutely shattered all week, so I'm glad it's Friday.",
    "I see what you mean, although I'm not entirely convinced it'd work in practice.",
    "We ended up going to that little pub by the river. Have you ever been?",
    "If I'd known it was going to rain, I'd have brought an umbrella, to be fair.",
]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    audio = args.out / "audio"
    work = args.out / "wav"
    audio.mkdir(parents=True, exist_ok=True)
    work.mkdir(exist_ok=True)

    random.seed(20261105)
    order = VOICES[:]
    random.shuffle(order)
    labels = {voice: f"Voice {chr(ord('A') + i)}" for i, voice in enumerate(order)}
    samples = []
    for voice in VOICES:
        for index, sentence in enumerate(SENTENCES):
            wav = work / f"{voice}.{index}.wav"
            result = subprocess.run(
                [str(POCKET), "generate", "--language", "english", "--voice", voice, "--text", sentence, "--output-path", str(wav), "--quiet"],
                capture_output=True, text=True,
            )
            if result.returncode != 0:
                print(f"{voice} failed: {result.stderr.strip()[:200]}")
                break
            name = f"{labels[voice].replace(' ', '')}-{index}-100.mp3"
            to_mp3(wav, audio / name)
            samples.append({"label": labels[voice], "sentence": index, "speed": 1, "file": f"audio/{name}"})
    write_page(
        args.out / "index.html",
        title="Which voice could be your English partner?",
        intro=(
            "He's a British man in his thirties, and the partner for learners at B2 to C1 level. Listen for a voice "
            "that sounds natural, clearly British, and like someone you'd enjoy talking to every day. Names stay hidden until the end."
        ),
        clips=[["▶ Play", 1]],
        criteria=[["natural", "Natural"], ["british", "Sounds British"], ["him", "Could be him"]],
        key="voice-test-english",
        sentences=SENTENCES,
        samples=samples,
        labels={label: voice for voice, label in labels.items()},
    )
    shutil.rmtree(work)
    print(f"{len(samples)} clips for {len({s['label'] for s in samples})} voices")


if __name__ == "__main__":
    main()
