#!/usr/bin/env python3
"""Tests the real installer the way a new user would meet it, on this Windows machine:
install, first-run screen, real downloads, a crash, a run without internet, and uninstall.

    test-installer.py --prompts FILE --out DIR
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
LOCAL = Path(subprocess.run(["wslpath", "-u", subprocess.run(["cmd.exe", "/c", "echo %LOCALAPPDATA%"], capture_output=True, text=True, cwd="/mnt/c").stdout.strip()], capture_output=True, text=True).stdout.strip())
INSTALLED = LOCAL / "Programs/conversationer"
EXE = INSTALLED / "Conversationer.exe"
DATA = LOCAL / "Conversationer"
TEMP = LOCAL / "Temp/conversationer-installer-test"
SIDECARS = ["llama-server.exe", "whisper-server.exe", "pocket-tts.exe"]
PORT = 18095


def win(path: Path) -> str:
    return subprocess.run(["wslpath", "-w", str(path)], capture_output=True, text=True, check=True).stdout.strip()


def free_gb() -> float:
    usage = shutil.disk_usage("/mnt/c")
    return round(usage.free / 1e9, 1)


def running() -> dict[str, int]:
    out = subprocess.run(["tasklist.exe"], capture_output=True, text=True).stdout.lower()
    names = [*SIDECARS, "conversationer.exe"]
    return {name: out.count(name) for name in names if out.count(name)}


def launch(**extra: str) -> subprocess.Popen:
    env = {**os.environ, **extra, "WSLENV": ":".join([os.environ.get("WSLENV", ""), *extra])}
    return subprocess.Popen([str(EXE)], env=env, cwd=INSTALLED, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def events(log: Path) -> list[dict]:
    return [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()] if log.exists() else []


def summarise(entries: list[dict]) -> None:
    ended = None
    for e in entries:
        kind = e.get("event")
        if kind == "services_ready":
            print("  using", e["model"], "on", e["device"], "/ whisper", e["whisper"]["build"], flush=True)
        if kind == "warmed_up":
            print("  warm-up", e["ms"], "ms", flush=True)
        if kind == "turn_ended":
            ended = e["at"]
        if kind == "heard":
            print("  heard in", e["ms"], "ms:", e.get("text"), flush=True)
        if kind == "first_audio" and ended:
            print("  first audio", e["at"] - ended, "ms after the turn ended", flush=True)
        if kind == "reply":
            print("  jonas:", e.get("text"), flush=True)
        if kind in ("error", "setup_failed", "startup_failed", "autotest_timed_out", "autotest_finished"):
            print("  ", e, flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompts", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    TEMP.mkdir(parents=True, exist_ok=True)
    if DATA.exists() or INSTALLED.exists():
        raise SystemExit("Already installed: this test needs a clean start.")

    print(f"== Free on C: {free_gb()} GB", flush=True)
    setup = TEMP / "Conversationer-Setup.exe"
    shutil.copyfile(next((ROOT / "release").glob("*.exe")), setup)
    microphone = TEMP / "mic.wav"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(ROOT / "evals/results/speech-speed/speech1.wav"), "-af", "apad=pad_dur=5", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", str(microphone)], check=True)

    print("== 1. Install", flush=True)
    started = time.time()
    subprocess.run([str(setup), "/S"], check=True, cwd=TEMP)
    for _ in range(120):
        if EXE.exists():
            break
        time.sleep(1)
    time.sleep(3)
    size = sum(f.stat().st_size for f in INSTALLED.rglob("*") if f.is_file())
    print(f"  installed in {time.time() - started:.0f} s, {size / 1e6:.0f} MB, exe present: {EXE.exists()}", flush=True)
    print("  uninstaller:", [p.name for p in INSTALLED.glob("Uninstall*")], flush=True)
    print("  notices:", (INSTALLED / "resources/THIRD_PARTY_NOTICES.txt").exists(), (INSTALLED / "resources/LICENSE.txt").exists(), flush=True)

    print("== 2. First-run screen (nothing downloaded yet)", flush=True)
    probe_home = TEMP / "first-run"
    probe_home.mkdir(exist_ok=True)
    app = launch(CONVERSATIONER_HOME=win(probe_home), CONVERSATIONER_CAPTURE_AFTER_MS="9000")
    app.wait(timeout=120)
    time.sleep(2)
    shutil.copyfile(probe_home / "logs/capture.png", args.out / "first-run.png")
    print("  still downloading nothing without consent:", sorted(p.name for p in probe_home.rglob("*") if p.is_file() and p.suffix not in (".png", ".log")), flush=True)
    shutil.rmtree(probe_home, ignore_errors=True)

    print("== 3. First real run: downloads from public sources", flush=True)
    started = time.time()
    fake = {"CONVERSATIONER_FAKE_MIC": win(microphone), "CONVERSATIONER_AUTOTEST": "2", "CONVERSATIONER_DEBUG": "1"}
    app = launch(**fake)
    last = 0.0
    while app.poll() is None and time.time() - started < 5400:
        time.sleep(30)
        now = free_gb()
        if abs(now - last) >= 0.5:
            print(f"  {time.time() - started:.0f} s: {now} GB free on C:", flush=True)
            last = now
    print(f"  finished in {time.time() - started:.0f} s, exit {app.poll()}", flush=True)
    log = DATA / "logs/session.log"
    summarise(events(log))
    if (DATA / "logs/autotest.png").exists():
        shutil.copyfile(DATA / "logs/autotest.png", args.out / "first-conversation.png")
    print("  downloaded:", {str(f.relative_to(DATA)): round(f.stat().st_size / 1e9, 2) for f in (DATA / "models").rglob("*") if f.is_file()}, flush=True)
    print(f"  data folder: {sum(f.stat().st_size for f in DATA.rglob('*') if f.is_file()) / 1e9:.1f} GB, free on C: {free_gb()} GB, left running: {running()}", flush=True)

    print("== 4. Crash: kill the app outright, then start it again", flush=True)
    log.unlink(missing_ok=True)
    app = launch(CONVERSATIONER_DEBUG="1")
    for _ in range(240):
        if any(e.get("event") == "warmed_up" for e in events(log)):
            break
        time.sleep(1)
    subprocess.run(["taskkill.exe", "/F", "/IM", "Conversationer.exe"], capture_output=True)
    time.sleep(3)
    left = running()
    print("  after the crash, still running:", left, "| record kept:", (DATA / "running.json").exists(), flush=True)

    print("== 5. Restart with the internet blocked (also clears those leftovers)", flush=True)
    log.unlink(missing_ok=True)
    blocked = {**fake, "HTTPS_PROXY": "http://127.0.0.1:9", "HTTP_PROXY": "http://127.0.0.1:9", "ALL_PROXY": "http://127.0.0.1:9"}
    app = launch(**blocked)
    try:
        app.wait(timeout=420)
    except subprocess.TimeoutExpired:
        print("  TIMED OUT", flush=True)
        subprocess.run(["taskkill.exe", "/F", "/IM", "Conversationer.exe"], capture_output=True)
    summarise(events(log))
    time.sleep(4)
    print("  left running:", running(), flush=True)

    print("== 6. Reading the downloaded Gemma's replies to real prompts", flush=True)
    server = subprocess.Popen(
        [str(next((INSTALLED / "resources/sidecars/llama").rglob("llama-server.exe"))), "-m", win(DATA / "models/llm/gemma4-e4b-it-qat.gguf"), "-c", "4096", "-ngl", "99", "--device", "Vulkan0", "--port", str(PORT), "--reasoning", "off"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=TEMP,
    )
    try:
        for _ in range(240):
            code = subprocess.run(["curl.exe", "-s", "-o", "NUL", "-w", "%{http_code}", "-m", "2", f"http://127.0.0.1:{PORT}/health"], capture_output=True, text=True).stdout
            if code.strip() == "200":
                break
            time.sleep(1)
        first = []
        for messages in json.loads(args.prompts.read_text(encoding="utf-8")):
            body = json.dumps({"messages": messages, "temperature": 0.6, "max_tokens": 60, "stream": False, "reasoning_effort": "none"})
            out = subprocess.run(["curl.exe", "-s", "-X", "POST", f"http://127.0.0.1:{PORT}/v1/chat/completions", "-H", "content-type: application/json", "--data-binary", "@-"], input=body, capture_output=True, text=True, encoding="utf-8").stdout
            answer = json.loads(out)
            t = answer["timings"]
            first.append(t["prompt_ms"] + 12 * t["predicted_ms"] / max(t["predicted_n"], 1))
            print("  user:", messages[-1]["content"].split("\n")[0][:70], flush=True)
            print("    ->", answer["choices"][0]["message"]["content"].split("[")[0].strip()[:130], flush=True)
        print(f"  first sentence median {statistics.median(first[1:]):.0f} ms", flush=True)
    finally:
        server.terminate()
        subprocess.run(["taskkill.exe", "/F", "/IM", "llama-server.exe"], capture_output=True)
        time.sleep(2)

    print("== 7. Uninstall", flush=True)
    shutil.copytree(DATA / "logs", args.out / "logs", dirs_exist_ok=True)
    uninstaller = next(INSTALLED.glob("Uninstall*"))
    subprocess.run([str(uninstaller), "/S"], cwd=TEMP)
    for _ in range(90):
        if not DATA.exists() and not EXE.exists():
            break
        time.sleep(1)
    print(f"  app removed: {not EXE.exists()}, models and data removed: {not DATA.exists()}, free on C: {free_gb()} GB", flush=True)
    shutil.rmtree(TEMP, ignore_errors=True)
    print("  left running:", running(), flush=True)


if __name__ == "__main__":
    main()
