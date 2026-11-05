#!/usr/bin/env python3
"""Measures how to spend the GPU on Windows: a better Whisper, and bigger LLMs beside it.

    windows-gpu.py --prompts FILE --models-dir DIR --whisper-dir DIR --out FILE

Works from a temporary local folder, holding one large model at a time, and removes it afterwards.
"""
import argparse
import json
import shutil
import statistics
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCAL_APP_DATA = subprocess.run(["cmd.exe", "/c", "echo %LOCALAPPDATA%"], capture_output=True, text=True, cwd="/mnt/c").stdout.strip()
WIN = Path(subprocess.run(["wslpath", "-u", LOCAL_APP_DATA], capture_output=True, text=True).stdout.strip()) / "Temp/conversationer-test"
WHISPER_PORT = 18091
LLM_PORT = 18090
FIRST_SENTENCE_TOKENS = 12

# (ollama name, gpu layers, note). 99 means everything.
LLM_RUNS = [
    ("gemma4:e4b-it-qat", "99", "for comparison"),
    ("gemma4:12b-it-qat", "28", "partly on GPU"),
    ("gemma4:12b-it-qat", "22", "partly on GPU"),
    ("qwen3.5:9b-q4_K_M", "99", "all on GPU if it fits"),
]


def win_path(path: Path) -> str:
    return subprocess.run(["wslpath", "-w", str(path)], capture_output=True, text=True, check=True).stdout.strip()


def curl(*args: str, stdin: str | None = None, timeout: int = 300) -> str:
    return subprocess.run(["curl.exe", "-s", *args], input=stdin, capture_output=True, text=True, encoding="utf-8", timeout=timeout).stdout


def wait_for(url: str, process: subprocess.Popen, timeout: int = 300) -> float:
    started = time.perf_counter()
    while time.perf_counter() - started < timeout:
        if process.poll() is not None:
            raise RuntimeError(f"exited with {process.returncode}")
        if curl("-o", "NUL", "-w", "%{http_code}", "-m", "2", url).strip() == "200":
            return time.perf_counter() - started
        time.sleep(0.25)
    raise RuntimeError("didn't start in time")


def gpu_mib() -> int:
    out = subprocess.run(["nvidia-smi.exe", "--query-gpu=memory.used", "--format=csv,noheader,nounits"], capture_output=True, text=True, check=True)
    return int(out.stdout.strip())


def stop(process: subprocess.Popen, image: str) -> None:
    process.terminate()
    subprocess.run(["taskkill.exe", "/F", "/IM", image], capture_output=True)
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
    time.sleep(3)


def start_whisper(folder: str, model: str, whisper_dir: Path, threads: str = "8") -> subprocess.Popen:
    exe = WIN / folder / "Release/whisper-server.exe"
    for name in (model, "ggml-silero-v6.2.0.bin"):
        if not (WIN / name).exists():
            shutil.copyfile(whisper_dir / name, WIN / name)
    return subprocess.Popen(
        [str(exe), "-m", win_path(WIN / model), "-l", "de", "-t", threads, "--port", str(WHISPER_PORT),
         "--vad", "-vm", win_path(WIN / "ggml-silero-v6.2.0.bin")],
        stdout=open(ROOT / "evals/results/windows-whisper.log", "a"), stderr=subprocess.STDOUT, cwd=exe.parent,
    )


def transcribe_all() -> list[dict]:
    results = []
    for wav in sorted(WIN.glob("clip*.wav")):
        out = curl("-w", "\\n%{time_total}", "-F", f"file=@{win_path(wav)}", "-F", "response_format=json", f"http://127.0.0.1:{WHISPER_PORT}/inference")
        body, seconds = out.rsplit("\n", 1)
        results.append({"clip": wav.stem, "s": round(float(seconds), 2), "heard": json.loads(body)["text"].strip()})
    return results


def measure_whisper(folder: str, model: str, whisper_dir: Path) -> dict:
    before = gpu_mib()
    server = start_whisper(folder, model, whisper_dir)
    try:
        wait_for(f"http://127.0.0.1:{WHISPER_PORT}/", server)
        # The first run includes one-off GPU set-up, so it's discarded.
        transcribe_all()
        results = transcribe_all()
        return {"whisper": folder, "model": model, "gpu_mib": gpu_mib() - before, "median_s": statistics.median(r["s"] for r in results), "results": results}
    finally:
        stop(server, "whisper-server.exe")


def ollama_blob(name: str) -> Path:
    out = subprocess.run(["ollama", "show", "--modelfile", name], capture_output=True, text=True, check=True).stdout
    return Path(next(line.split(" ", 1)[1] for line in out.splitlines() if line.startswith("FROM /")))


def measure_llm(name: str, layers: str, note: str, prompts: list) -> dict:
    local = WIN / "model.gguf"
    shutil.copyfile(ollama_blob(name), local)
    before = gpu_mib()
    server = subprocess.Popen(
        [str(WIN / "llama/llama-server.exe"), "-m", win_path(local), "-c", "4096", "-ngl", layers, "--device", "Vulkan0",
         "--port", str(LLM_PORT), "--reasoning", "off", "-t", "8"],
        stdout=open(ROOT / "evals/results/windows-llm.log", "a"), stderr=subprocess.STDOUT, cwd=WIN / "llama",
    )
    try:
        wait_for(f"http://127.0.0.1:{LLM_PORT}/health", server)
        used = gpu_mib() - before
        first, speed, replies = [], [], []
        for messages in prompts:
            body = json.dumps({"messages": messages, "temperature": 0.6, "max_tokens": 60, "stream": False, "reasoning_effort": "none"})
            answer = json.loads(curl("-X", "POST", f"http://127.0.0.1:{LLM_PORT}/v1/chat/completions", "-H", "content-type: application/json", "--data-binary", "@-", stdin=body))
            t = answer["timings"]
            first.append(t["prompt_ms"] + FIRST_SENTENCE_TOKENS * t["predicted_ms"] / max(t["predicted_n"], 1))
            speed.append(t["predicted_per_second"])
            replies.append(answer["choices"][0]["message"]["content"].split("[")[0].strip()[:110])
        return {
            "llm": name, "layers": layers, "note": note, "gpu_mib": used,
            "first_sentence_ms_median": round(statistics.median(first[1:])), "first_sentence_ms_worst": round(max(first[1:])),
            "tokens_per_s": round(statistics.median(speed[1:]), 1), "replies": replies[:6],
        }
    finally:
        stop(server, "llama-server.exe")
        local.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompts", type=Path, required=True)
    parser.add_argument("--whisper-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    prompts = json.loads(args.prompts.read_text(encoding="utf-8"))

    WIN.mkdir(parents=True, exist_ok=True)
    source = ROOT / "sidecars/win"
    for name in ("llama", "whisper", "whisper-cuda"):
        shutil.copytree(source / name, WIN / name, dirs_exist_ok=True)
    # Speech with a little room noise, to be harder than clean synthetic audio.
    for index, wav in enumerate(sorted((ROOT / "evals/results/speech-speed").glob("speech*.wav"))):
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), "-f", "lavfi", "-i", "anoisesrc=c=pink:a=0.02:r=24000",
             "-filter_complex", "amix=inputs=2:duration=first", "-ar", "16000", "-ac", "1", str(WIN / f"clip{index}.wav")],
            check=True,
        )

    report: dict = {"whisper": [], "llm": []}
    for folder, model in [("whisper", "ggml-base-q5_1.bin"), ("whisper-cuda", "ggml-base-q5_1.bin"), ("whisper-cuda", "ggml-small-q5_1.bin"), ("whisper-cuda", "ggml-large-v3-turbo-q5_0.bin")]:
        try:
            result = measure_whisper(folder, model, args.whisper_dir)
            report["whisper"].append(result)
            print(json.dumps(result, ensure_ascii=False), flush=True)
        except Exception as error:
            print("whisper", folder, model, "FAILED", error, flush=True)
    for name, layers, note in LLM_RUNS:
        try:
            result = measure_llm(name, layers, note, prompts)
            report["llm"].append(result)
            print(json.dumps(result, ensure_ascii=False), flush=True)
        except Exception as error:
            print("llm", name, layers, "FAILED", error, flush=True)

    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    shutil.rmtree(WIN, ignore_errors=True)
    print("Temporary folder removed:", not WIN.exists())


if __name__ == "__main__":
    main()
