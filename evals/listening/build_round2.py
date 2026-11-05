#!/usr/bin/env python3
"""Round two of the voice test, after Pocket TTS `german` won round one.

Round one's winner is a single male voice with weak slow speech. This builds two blind pages:

  voices/  other Pocket TTS voices speaking through the German model, to find one for Lena
  slow/    ways to slow Pocket TTS down, since the model has no speed setting

It also prints streaming speed at low thread counts. Run it with the Python that has pocket-tts:

    build_round2.py --out DIR
"""
import argparse
import json
import random
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import scipy.io.wavfile
import torch
from pocket_tts import TTSModel

sys.path.insert(0, str(Path(__file__).parent))
from build import SENTENCES, duration_seconds, to_mp3, write_page  # noqa: E402

# Left out: voices from datasets marked non-commercial on Kyutai's voice page (Expresso, EARS).
VOICES = ["juergen", "alba", "anna", "vera", "fantine", "eponine", "azelma", "mary", "jane", "eve"]

# (tempo, pause between phrases in ms). A is what round one tested.
SLOW_METHODS = {
    "A: stretch to 0.80, no added pauses": (0.8, 0),
    "B: stretch to 0.90, 350 ms pauses": (0.9, 350),
    "C: no stretch, 450 ms pauses": (None, 450),
    "D: stretch to 0.85, 250 ms pauses": (0.85, 250),
}


def phrases(sentence: str) -> list[str]:
    """Splits where the text itself allows a pause, as the app could do for any sentence."""
    return [part.strip() for part in re.findall(r"[^,.!?]+[,.!?]+", sentence)]


def save(path: Path, audio: torch.Tensor | np.ndarray, rate: int) -> None:
    scipy.io.wavfile.write(path, rate, np.asarray(audio))


def measure_streaming(model: TTSModel, state) -> None:
    print("Streaming speed on the CPU (Python package, not the release binary):")
    for threads in (2, 4, 8):
        torch.set_num_threads(threads)
        firsts, factors = [], []
        for sentence in SENTENCES * 2:
            started = time.perf_counter()
            first = None
            samples = 0
            for chunk in model.generate_audio_stream(state, sentence):
                first = first or time.perf_counter() - started
                samples += chunk.shape[-1]
            factors.append((samples / model.sample_rate) / (time.perf_counter() - started))
            firsts.append(first)
        firsts.sort()
        print(
            f"  {threads} threads: first audio median {firsts[len(firsts) // 2] * 1000:.0f} ms, "
            f"worst {firsts[-1] * 1000:.0f} ms, {min(factors):.1f}x to {max(factors):.1f}x real time"
        )
    torch.set_num_threads(4)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    model = TTSModel.load_model(language="german")
    rate = model.sample_rate
    states = {}
    for voice in VOICES:
        try:
            states[voice] = model.get_state_for_audio_prompt(voice)
        except Exception as error:  # A voice missing for German is a finding, not a failure.
            print(f"Skipping {voice}: {error}")
    print(f"Voices available with the German model: {list(states)}")
    measure_streaming(model, states["juergen"])

    random.seed(20261103)

    # --- Voices
    voices_dir = args.out / "voices"
    (voices_dir / "audio").mkdir(parents=True, exist_ok=True)
    work = args.out / "wav"
    work.mkdir(exist_ok=True)
    names = list(states)
    random.shuffle(names)
    labels = {voice: f"Voice {chr(ord('A') + i)}" for i, voice in enumerate(names)}
    samples = []
    for voice, state in states.items():
        for index, sentence in enumerate(SENTENCES):
            wav = work / f"{voice}.{index}.wav"
            save(wav, model.generate_audio(state, sentence), rate)
            name = f"{labels[voice].replace(' ', '')}-{index}-100.mp3"
            to_mp3(wav, voices_dir / "audio" / name)
            samples.append({"label": labels[voice], "sentence": index, "speed": 1, "file": f"audio/{name}"})
    write_page(
        voices_dir / "index.html",
        title="Which voice could be Lena?",
        intro=(
            "All of these speak through the German model you preferred. Lena is a woman from Leipzig, so listen for "
            "a voice that suits her and sounds properly German, with no foreign accent. Names stay hidden until the end."
        ),
        clips=[["▶ Play", 1]],
        criteria=[["natural", "Natural"], ["german", "Sounds German"], ["lena", "Could be Lena"]],
        key="voice-test-round2-voices",
        sentences=SENTENCES,
        samples=samples,
        labels={label: voice for voice, label in labels.items()},
    )

    # --- Slow speech
    slow_dir = args.out / "slow"
    (slow_dir / "audio").mkdir(parents=True, exist_ok=True)
    state = states["juergen"]
    methods = list(SLOW_METHODS)
    random.shuffle(methods)
    method_labels = {method: f"Method {chr(ord('A') + i)}" for i, method in enumerate(methods)}
    samples = []
    ratios = {method: [0.0, 0.0] for method in methods}
    for index, sentence in enumerate(SENTENCES):
        normal = work / f"juergen.{index}.wav"
        parts = [model.generate_audio(state, part).numpy() for part in phrases(sentence)]
        for method, (tempo, pause_ms) in SLOW_METHODS.items():
            if pause_ms:
                silence = np.zeros(int(rate * pause_ms / 1000), dtype=parts[0].dtype)
                joined = [piece for part in parts for piece in (part, silence)][:-1]
                source = work / f"slow.{index}.{pause_ms}.wav"
                save(source, np.concatenate(joined), rate)
            else:
                source = normal
            label = method_labels[method]
            name = f"{label.replace(' ', '')}-{index}-100.mp3"
            to_mp3(source, slow_dir / "audio" / name, tempo)
            samples.append({"label": label, "sentence": index, "speed": 1, "file": f"audio/{name}"})
            ratios[method][0] += duration_seconds(slow_dir / "audio" / name)
            ratios[method][1] += duration_seconds(normal)
    write_page(
        slow_dir / "index.html",
        title="Which slow speech works best for a learner?",
        intro=(
            "The same voice, slowed down in different ways. Rate how natural it still sounds, how easy it is to follow, "
            "and whether it gives you enough time as a learner. Names stay hidden until the end."
        ),
        clips=[["▶ Play", 1]],
        criteria=[["natural", "Still natural"], ["clear", "Easy to follow"], ["time", "Gives enough time"]],
        key="voice-test-round2-slow",
        sentences=SENTENCES,
        samples=samples,
        labels={label: method for method, label in method_labels.items()},
    )
    shutil.rmtree(work)
    print("Slow speech, length compared with normal speed:")
    print(json.dumps({method: round(spoken / plain, 2) for method, (spoken, plain) in ratios.items()}, indent=2))


if __name__ == "__main__":
    main()
