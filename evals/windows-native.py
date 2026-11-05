#!/usr/bin/env python3
"""Measures the Windows builds natively, launched from WSL.

WSL in NAT mode can't reach Windows' localhost, so requests go through Windows' own curl.exe, and
LLM speed comes from the server's own timings, so process start-up doesn't count against it.

    windows-native.py --prompts FILE --out FILE
"""
import argparse
import json
import os
import shutil
import statistics
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Windows programs misbehave when run from a \\\\wsl.localhost path, and a real install is on local disk.
# This folder is removed afterwards, and it never holds more than one LLM, to go easy on the C: drive.
LOCAL_APP_DATA = subprocess.run(["cmd.exe", "/c", "echo %LOCALAPPDATA%"], capture_output=True, text=True, cwd="/mnt/c").stdout.strip()
WIN = Path(subprocess.run(["wslpath", "-u", LOCAL_APP_DATA], capture_output=True, text=True).stdout.strip()) / "Temp/conversationer-test"
SOURCE = ROOT / "sidecars/win"
LLM_PORT = 18090
WHISPER_PORT = 18091
TTS_PORT = 18092
CONTEXT = 4096
MAX_TOKENS = 60
# Roughly how many tokens a short first sentence takes, to estimate when it's ready.
FIRST_SENTENCE_TOKENS = 12

LLM_RUNS = [
    ("gemma4-e4b-it-qat.gguf", "Vulkan0", "RTX 5070"),
    ("gemma4-12b-it-qat.gguf", "Vulkan0", "RTX 5070"),
    ("gemma4-e2b-it-qat.gguf", "Vulkan0", "RTX 5070"),
    ("gemma4-e2b-it-qat.gguf", "Vulkan1", "Intel integrated"),
    ("gemma4-e4b-it-qat.gguf", "Vulkan1", "Intel integrated"),
    ("gemma4-e2b-it-qat.gguf", "none", "CPU only, 8 threads"),
]
WHISPER_MODELS = ["ggml-base-q5_1.bin", "ggml-small-q5_1.bin"]


def win_path(path: Path) -> str:
    return subprocess.run(["wslpath", "-w", str(path)], capture_output=True, text=True, check=True).stdout.strip()


def curl(*args: str, stdin: str | None = None, timeout: int = 300) -> str:
    return subprocess.run(["curl.exe", "-s", *args], input=stdin, capture_output=True, text=True, encoding="utf-8", timeout=timeout).stdout


def wait_for(url: str, process: subprocess.Popen, timeout: int = 400) -> float:
    started = time.perf_counter()
    while time.perf_counter() - started < timeout:
        if process.poll() is not None:
            raise RuntimeError(f"{url}: process exited with {process.returncode}")
        if curl("-o", "NUL", "-w", "%{http_code}", "-m", "2", url).strip() == "200":
            return time.perf_counter() - started
        time.sleep(0.25)
    raise RuntimeError(f"{url} didn't start in time")


def gpu_memory_mib() -> int:
    out = subprocess.run(
        ["nvidia-smi.exe", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
        capture_output=True, text=True, check=True,
    )
    return int(out.stdout.strip())


def stop(process: subprocess.Popen, image: str) -> None:
    process.terminate()
    # Terminating the WSL side of an interop process can leave the Windows program running.
    subprocess.run(["taskkill.exe", "/F", "/IM", image], capture_output=True)
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()


def measure_llm(model: str, device: str, name: str, prompts: list) -> dict:
    local_model = WIN / model
    shutil.copyfile(ROOT / "sidecars/models/llm" / model, local_model)
    time.sleep(2)
    before = gpu_memory_mib()
    layers = "0" if device == "none" else "99"
    command = [
        str(WIN / "llama/llama-server.exe"), "-m", win_path(local_model),
        "-c", str(CONTEXT), "-ngl", layers, "--port", str(LLM_PORT), "--reasoning", "off", "-t", "8",
    ]
    if device != "none":
        command += ["--device", device]
    log = open(ROOT / "evals/results/windows-llm.log", "a", encoding="utf-8")
    server = subprocess.Popen(command, stdout=log, stderr=log, cwd=WIN / "llama")
    try:
        load_seconds = wait_for(f"http://127.0.0.1:{LLM_PORT}/health", server)
        used = gpu_memory_mib() - before
        prompt_ms, per_second, first = [], [], []
        replies = []
        for messages in prompts:
            body = json.dumps({"messages": messages, "temperature": 0.6, "max_tokens": MAX_TOKENS, "stream": False, "reasoning_effort": "none"})
            raw = curl("-X", "POST", f"http://127.0.0.1:{LLM_PORT}/v1/chat/completions", "-H", "content-type: application/json", "--data-binary", "@-", stdin=body)
            answer = json.loads(raw)
            timings = answer["timings"]
            prompt_ms.append(timings["prompt_ms"])
            per_second.append(timings["predicted_per_second"])
            first.append(timings["prompt_ms"] + FIRST_SENTENCE_TOKENS * timings["predicted_ms"] / max(timings["predicted_n"], 1))
            replies.append(answer["choices"][0]["message"]["content"][:90])
        # The first prompt fills the cache, so it's a one-off cost, reported separately from the rest.
        result = {
            "model": model, "device": name, "load_s": round(load_seconds, 1),
            "nvidia_memory_mib": used if device == "Vulkan0" else None,
            "first_prompt_ms": round(prompt_ms[0]),
            "prompt_ms_median": round(statistics.median(prompt_ms[1:])),
            "tokens_per_s": round(statistics.median(per_second[1:]), 1),
            "first_sentence_ms_median": round(statistics.median(first[1:])),
            "first_sentence_ms_worst": round(max(first[1:])),
            "sample": replies[2],
        }
    finally:
        stop(server, "llama-server.exe")
        time.sleep(3)
        local_model.unlink(missing_ok=True)
    return result


def measure_whisper(model: str) -> dict:
    exe = WIN / "whisper/Release/whisper-server.exe"
    server = subprocess.Popen(
        [str(exe), "-m", win_path(WIN / model), "-l", "de", "-t", "8", "--port", str(WHISPER_PORT),
         "--vad", "-vm", win_path(WIN / "ggml-silero-v6.2.0.bin")],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=exe.parent,
    )
    try:
        wait_for(f"http://127.0.0.1:{WHISPER_PORT}/", server)
        times, heard = [], []
        for name in ["speech0", "speech1", "speech2", "silence"]:
            wav = win_path(WIN / f"{name}.wav")
            out = curl("-w", "\\n%{time_total}", "-F", f"file=@{wav}", "-F", "response_format=json", f"http://127.0.0.1:{WHISPER_PORT}/inference")
            body, seconds = out.rsplit("\n", 1)
            heard.append(json.loads(body)["text"].strip())
            if name != "silence":
                times.append(float(seconds))
        return {"model": model, "seconds_each": [round(t, 2) for t in times], "heard": heard}
    finally:
        stop(server, "whisper-server.exe")


def measure_tts() -> dict:
    exe = next((WIN / "pocket-tts").glob("*/pocket-tts.exe"))
    # Keeps the model download in the temporary folder rather than the user's Windows profile.
    env = {**os.environ, "HF_HOME": win_path(WIN / "hf-cache"), "WSLENV": f"{os.environ.get('WSLENV', '')}:HF_HOME"}  # Removed with the folder.
    server = subprocess.Popen(
        [str(exe), "serve", "--language", "german", "--default-voice", "juergen", "--port", str(TTS_PORT)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=exe.parent, env=env,
    )
    try:
        load_seconds = wait_for(f"http://localhost:{TTS_PORT}/health", server)
        runs = []
        for text in ["Mein Hund wollte heute Morgen nicht nach Hause gehen.", "Ich arbeite seit sechs Jahren in der Bäckerei.", "Schön, dich kennenzulernen!"]:
            target = WIN / "tts-test.wav"
            out = curl("-o", win_path(target), "-w", "%{time_starttransfer} %{time_total}", "--data-urlencode", f"text={text}", f"http://localhost:{TTS_PORT}/tts")
            first_byte, total = out.split()
            probe = subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(target)],
                capture_output=True, text=True,
            )
            runs.append({"first_byte_s": float(first_byte), "total_s": float(total), "audio_s": float(probe.stdout or 0)})
        return {"load_s": round(load_seconds, 1), "runs": runs}
    finally:
        stop(server, "pocket-tts.exe")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompts", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    prompts = json.loads(args.prompts.read_text(encoding="utf-8"))

    WIN.mkdir(parents=True, exist_ok=True)
    for name in ("llama", "whisper", "pocket-tts"):
        shutil.copytree(SOURCE / name, WIN / name, dirs_exist_ok=True)
    for model in [*WHISPER_MODELS, "ggml-silero-v6.2.0.bin"]:
        shutil.copyfile(ROOT / "sidecars/models/whisper" / model, WIN / model)
    for name in ["speech0", "speech1", "speech2", "silence"]:
        shutil.copyfile(ROOT / f"evals/results/speech-speed/{name}.wav", WIN / f"{name}.wav")

    report: dict = {"llm": [], "whisper": [], "tts": None}
    for step, run in [("tts", measure_tts), *[(f"whisper {m}", lambda m=m: measure_whisper(m)) for m in WHISPER_MODELS]]:
        try:
            result = run()
            print(step, json.dumps(result, ensure_ascii=False), flush=True)
            if step == "tts":
                report["tts"] = result
            else:
                report["whisper"].append(result)
        except Exception as error:
            print(step, "FAILED", error, flush=True)
    for model, device, name in LLM_RUNS:
        try:
            result = measure_llm(model, device, name, prompts)
            report["llm"].append(result)
            print("llm", json.dumps(result, ensure_ascii=False), flush=True)
        except Exception as error:
            print("llm", model, name, "FAILED", error, flush=True)
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    shutil.rmtree(WIN, ignore_errors=True)
    print("Temporary folder removed:", not WIN.exists())


if __name__ == "__main__":
    main()
