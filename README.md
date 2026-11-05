# Conversationer

A patient conversation partner for language learners, running entirely on your own computer.

General AI chat apps behave like assistants: they answer, then wrap up with "let me know if you need anything". Conversationer is built to hold an everyday conversation instead. The partner is curious about your day, talks about their own life, answers your questions, and never ends the conversation for you.

It's made for learners who freeze when talking to real people. **It never talks over you.** You take as long as you need to form a sentence, then press **I'm done**.

There are two partners:

- **Jonas**, a baker from Leipzig, for learners of German from beginner (A1) to good (B2). He speaks in simple sentences at lower levels, and uses the right form of what you said in his reply rather than correcting you.
- **Tom**, a teacher from Nottingham, for English at B2 and C1: natural British English for people who can already talk but are nervous of making mistakes with real people.

After a partner speaks, nothing is recorded until you press **Start speaking**, so you have time to take in what they said. **Hear again** replays it.

Under each thing you say there's a **How could I say that better?** button, so feedback only comes when you ask for it. It shows a better version with the changed words highlighted. Tom also says why. Jonas doesn't, because the model's explanations of German grammar were wrong too often to learn from.

## Download

Get the installer from [Releases](../../releases).

**You need:**
- Windows 10 or 11 (64-bit)
- At least 8 GB of RAM
- About 10 GB of free disk space
- A microphone

**A dedicated graphics card helps a lot.** With an NVIDIA card that has about 5 GB of graphics memory free, replies come in about a second and speech recognition is accurate. Other machines work, but more slowly, and they hear less accurately.

**First run:** Windows may warn that the app is from an unknown publisher, because it isn't code-signed yet. Click **More info**, then **Run anyway**. Choose a partner, and the app picks the right models for your computer, asks before downloading about 7 GB once, and works offline after that. Meeting the other partner later downloads their voice, about 0.3 GB.

**Feedback is about the words as speech recognition heard them.** Speech recognition tends to write what you probably meant, so it can quietly smooth out a mistake before feedback sees it. The app says so when it calls something you *said* natural. To check a sentence exactly, type it.

**Feedback** needs the larger model, which most computers with a dedicated graphics card get. On the smaller model it suggested fixes to correct sentences too often, so the button doesn't appear there.

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
