# Conversationer

A patient conversation partner for language learners, running entirely on your own computer.

General AI chat apps behave like assistants: they answer, then wrap up with "let me know if you need anything". Conversationer is built to hold an everyday conversation instead. The partner is curious about your day, talks about their own life, answers your questions, and never ends the conversation for you.

It's made for learners who freeze when talking to real people. **It never talks over you.** You take as long as you need to form a sentence, then press **I'm done**.

The first partner is **Jonas**, a baker from Leipzig, for learners of German from beginner (A1) to good (B2). He speaks in simple sentences at lower levels, and uses the right form of what you said in his reply rather than correcting you.

## Download

Get the installer from [Releases](../../releases).

**You need:**
- Windows 10 or 11 (64-bit)
- At least 8 GB of RAM
- About 10 GB of free disk space
- A microphone

**A dedicated graphics card helps a lot.** With an NVIDIA card that has about 5 GB of graphics memory free, replies come in about a second and speech recognition is accurate. Other machines work, but more slowly, and they hear less accurately.

**First run:** Windows may warn that the app is from an unknown publisher, because it isn't code-signed yet. Click **More info**, then **Run anyway**. The app then picks the right models for your computer, asks before downloading about 7 GB once, and works offline after that.

**Privacy:** nothing you say leaves your computer, and there's no account and no tracking. The partner is an AI, not a real person, and says so if you ask.

## How it works

- **Conversation:** an LLM ([Gemma 4](https://huggingface.co/google/gemma-4-E4B-it-qat-q4_0-gguf)) phrases each reply. Ordinary code decides what kind of reply comes next (answer, ask, share something, react) and checks every sentence before it's spoken. See [`packages/engine`](packages/engine).
- **Listening:** [whisper.cpp](https://github.com/ggml-org/whisper.cpp) turns speech into text, with a speech detector so silence isn't mistaken for words.
- **Speaking:** [Pocket TTS](https://github.com/kyutai-labs/pocket-tts) by Kyutai provides the voice.
- **Desktop app:** Electron, in [`apps/desktop`](apps/desktop). It picks the models for your hardware in [`packages/model-manager`](packages/model-manager).

Design notes and every measurement behind the choices are in [`evals/PHASE0.md`](evals/PHASE0.md).

## Building

Development happens in WSL on Windows, with Node 22.

```
npm install
npm test
npm run fetch-sidecars    # pinned, hash-checked builds of llama.cpp, whisper.cpp and Pocket TTS
npm run windows           # run the app on Windows from WSL
npm run package           # build the Windows installer into release/
```

## Licence

GPL-3.0. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) for the work this builds on.
