#!/usr/bin/env python3
"""Installs an older installer, then the new one over it, and checks nothing downloaded is lost.

    test-upgrade.py --old OLD.exe --new NEW.exe --out DIR

Stands in for real downloads with marker files, so it takes a minute rather than a 7 GB download.
"""
import argparse
import shutil
import subprocess
import time
from pathlib import Path

LOCAL = Path(subprocess.run(["wslpath", "-u", subprocess.run(["cmd.exe", "/c", "echo %LOCALAPPDATA%"], capture_output=True, text=True, cwd="/mnt/c").stdout.strip()], capture_output=True, text=True).stdout.strip())
INSTALLED = LOCAL / "Programs/conversationer"
EXE = INSTALLED / "Conversationer.exe"
DATA = LOCAL / "Conversationer"
TEMP = LOCAL / "Temp/conversationer-upgrade-test"
MARKERS = ["models/llm/gemma4-e4b-it-qat.gguf", "voices/german.ready", "settings.json"]


def win(path: Path) -> str:
    return subprocess.run(["wslpath", "-w", str(path)], capture_output=True, text=True, check=True).stdout.strip()


def installed_version() -> str:
    out = subprocess.run(
        ["powershell.exe", "-NoProfile", "-Command",
         "(Get-ItemProperty HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Conversationer*' }).DisplayVersion"],
        capture_output=True, text=True,
    )
    return out.stdout.strip() or "none"


def install(setup: Path) -> None:
    local = TEMP / setup.name
    shutil.copyfile(setup, local)
    subprocess.run([str(local), "/S"], cwd=TEMP, check=True)
    for _ in range(120):
        if EXE.exists():
            break
        time.sleep(1)
    time.sleep(5)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--old", type=Path, required=True)
    parser.add_argument("--new", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if EXE.exists() or DATA.exists():
        raise SystemExit("Already installed: this test needs a clean start.")
    TEMP.mkdir(parents=True, exist_ok=True)
    args.out.mkdir(parents=True, exist_ok=True)

    install(args.old)
    print(f"Old installed: version {installed_version()}", flush=True)
    for marker in MARKERS:
        path = DATA / marker
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('{"partner": "jonas", "levels": {}}' if marker == "settings.json" else "stand-in for a downloaded file")

    install(args.new)
    print(f"New installed over it: version {installed_version()}", flush=True)
    kept = {marker: (DATA / marker).exists() for marker in MARKERS}
    print(f"Downloaded files kept: {kept}", flush=True)
    print(f"Leftover old updater cache: {(LOCAL / 'conversationer-updater').exists()}", flush=True)

    # The new version should start straight into the saved partner, not the chooser.
    subprocess.Popen(
        [str(EXE)], cwd=INSTALLED, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        env={**__import__("os").environ, "CONVERSATIONER_CAPTURE_AFTER_MS": "8000", "WSLENV": "CONVERSATIONER_CAPTURE_AFTER_MS"},
    ).wait(timeout=120)
    time.sleep(2)
    if (DATA / "logs/capture.png").exists():
        shutil.copyfile(DATA / "logs/capture.png", args.out / "after-upgrade.png")

    uninstaller = next(INSTALLED.glob("Uninstall*"))
    subprocess.run([str(uninstaller), "/S"], cwd=TEMP)
    for _ in range(90):
        if not EXE.exists() and not DATA.exists():
            break
        time.sleep(1)
    time.sleep(3)
    print(f"Uninstalled: app gone {not EXE.exists()}, data gone {not DATA.exists()}, version {installed_version()}", flush=True)
    leftovers = [p.name for p in LOCAL.iterdir() if p.name.lower().startswith("conversationer") and p.name != "conversationer-dev"]
    print(f"Leftover folders: {leftovers}", flush=True)
    shutil.rmtree(TEMP, ignore_errors=True)


if __name__ == "__main__":
    main()
