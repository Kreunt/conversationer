# Phase 0 results

The character was called Lena through these tests. The user later chose a male character using the `juergen` voice, now named Jonas, so "Lena" below refers to him.

Measured 2026-11-02 on an i7-14650HX with an RTX 5070 Laptop (8 GB VRAM, about 6 GB free beside Windows), through Ollama under WSL2. Latency on real low-end hardware and on native Windows with Vulkan hasn't been measured.

Run again with `npm run eval -- --models <list>`. Try a model by hand with `npm run chat -- --model <name> --level A2`. Both use Ollama, and its models were deleted to save disk (WSL's disk is really on C:), so pull what you need first, such as `ollama pull gemma4:e4b-it-qat`. Transcripts land in `evals/results/`, which isn't committed.

## LLM: decision

Measured natively on Windows 11 with the shipped `llama-server.exe` (Vulkan), from a local folder. The machine is an i7-14650HX with an RTX 5070 Laptop (8 GB), Intel integrated graphics and 32 GB RAM.

| Machine | Default model | First sentence (median) | Worst | Speed | Graphics memory |
|---|---|---|---|---|---|
| Dedicated GPU, 8 GB | Gemma 4 E4B | 326 ms | 1081 ms | 80 tokens/s | 3.0 GB |
| Dedicated GPU, under about 4 GB free | Gemma 4 E2B | 171 ms | 204 ms | 138 tokens/s | 1.5 GB |
| No dedicated GPU | Gemma 4 E2B on the CPU | 1404 ms | 2705 ms | 18 tokens/s, 8 threads | n/a |
| 12 GB+ | Gemma 4 12B | not measured | | | won't load on 8 GB |

First-sentence times are calculated from the server's own timings, assuming about 12 tokens for a sentence. Earlier WSL runs through Ollama agreed closely.

**Findings that change the design:**

- **Never choose integrated graphics automatically.** E2B on Intel integrated took 4.6 s, three times slower than the CPU, and E4B took 8 s. It appears as a Vulkan device with plenty of (shared) memory, so a naive pick would choose it.
- **12B fails to load on 8 GB** ("failed to allocate buffer for kv cache"), so a failed load must step down a tier rather than show an error.
- **The first prompt can take 16–25 s** (20.8 s for E4B here, 216 ms for E2B straight after it), likely from building GPU shaders on first use. It should happen during loading, never in the first reply.
- **Programs must run from local disk.** Run from a `\\wsl.localhost` path, Pocket TTS couldn't use its cache and an E4B load hadn't finished after 400 s.
- This CPU is fast, so typical low-end machines will be slower than 1.4 s.

- **Gemma 4 E4B** reads best of the models that fit this GPU.
- **Gemma 4 12B** reads a little better, but doesn't load on this 8 GB card under Vulkan, and through Ollama it spilled to the CPU and took 2.1–4.7 s.
- **Gemma 4 E2B** is a strong surprise for 1.6 GB. It makes more slips and invents more ("Ich habe auch Kinder"), but stays usable.
- **Qwen 3.5 4B** is out: the same memory as E4B, with clearly worse German ("Oje, Deutschland kommst du vor zwei Jahren?") and a leak of Chinese into a German sentence.
- **Qwen 3.5 9B** is out for 8 GB: it reads naturally but spills to the CPU (0.75–1.6 s) and needs twice E4B's memory.
- `reasoning_effort: none` is required. Without it, Qwen spends its whole token budget on hidden reasoning.

**E2B is less reliable in conversation:** asked about things that aren't true of Jonas, it often plays along (it talks about a cat he doesn't have), where E4B corrects them. See `evals/probe.ts`.

**Limits of this result:** the quality judgement comes from an AI reading the transcripts, and only part of each was read. A fluent German speaker still needs to confirm it. The scripted learner also doesn't answer Lena's questions, which makes some exchanges look worse than they would in real use.

## Automatic metrics pass, but don't decide

On the final engine, across Gemma E2B, E4B and 12B (450 turns):

| Target from the plan | Result |
|---|---|
| 0 closing phrases spoken | 0 |
| 95%+ of replies within level limits | 100% |
| No dead ends | 0 |

"Dead end" here only means a move that had to ask and didn't. After the Director rework, statements without a question are deliberate, so this no longer implies a question every turn.

Every model scored about the same, including replies that were plainly bad. **These metrics can't see wrong German or an irrelevant reply.** Reading transcripts found every important problem, so reading stays part of any change to prompts or models.

The automatic closing-phrase check also only catches phrases on its list.

## Problems found by reading transcripts

All were engine or prompt bugs, not model limits, and all are fixed with tests.

| Problem | Cause | Fix |
|---|---|---|
| "Was hast du gegessen?" after everything | Models copied the example in my question instruction | Removed examples from it. Food questions fell from 22 to 4 (E2B and E4B, 300 turns) |
| "Übrigens, mein Fahrrad ist kaputt" after personal news | Timer-based topic change | Topics only change once answers fade |
| Unrelated persona stories | Whole day in the prompt, forced sharing | Stories only when the user gave nothing to relate to |
| Reading out "Stelle dann genau eine Frage dazu" | Only the first leaked sentence was caught | Stop at the first `[`, and check for imperatives |
| Unconnected replies | The opener guard removed the reaction | Only reject an opener used twice recently, and tell the model what to avoid |
| Constant echoing ("Du hast eine Katze.") | No reaction modelled | New instruction and examples. Now 0–10% of replies, and measured |
| Good sentences lost to an emoji | Rejected instead of cleaned | Strip the emoji |

The Director's note also moved from the system prompt to the latest message, which keeps the system prompt identical each turn so the server can reuse its cache. Replies improved after this, but it shipped alongside other prompt changes, so its own effect isn't measured.

## User feedback: it still felt like an AI

The user's real conversation showed problems the scripted learner couldn't: Lena ignored direct questions, and every turn was aimed at the user. Causes and fixes:

| Problem | Cause | Fix |
|---|---|---|
| Direct questions ignored | The Director couldn't tell the user had asked anything | New `answer` move, above everything except safety, honesty and goodbyes. A counter-question after answering is removed |
| Interview feeling | Most moves forced a question | Asking now alternates with telling, and never happens twice in a row |
| Dodging, inventing then forgetting | Lena had no life to answer from | A fixed list of facts about her |
| "danke" led to a random question | Short answers triggered an easy question | Acknowledgements get more talk from Lena instead |

Replaying that conversation on E4B at A2: questions in 25% of replies, and no counter-questions. Answer quality is better but not solved: of the 4 questions, 2 were answered well, "was ist mit ihr passiert?" got a weak answer about the cat's age, and the steak question got an answer about noodles (the replay never had Lena mention a steak, so that one isn't a fair test). In a 20-question check, 19 were answered directly and one vaguely ("Wo wohnt sie?" got "in einer großen Stadt" just after she'd said Berlin), and repeated facts stayed consistent (Bruno's age, her sister's city). She never said "Und du?", so she may now feel too passive when the user does the asking. The full bake-off on this design (E2B and E4B, 300 turns) spoke no closing phrases, dodged with no counter-questions, and asked questions in 48–51% of replies, as designed. E2B parrots more at A1 (22% of replies). Strict alternation may itself start to feel mechanical, which only real use will show.

The user then found two more faults: Lena agreed to false premises ("was hast du da gekauft?" at the bakery where she works) and changed the subject when challenged on a contradiction. New rules and examples fixed the premise on E4B (5 of 5 tries) and it stays on the subject when pressed (5 of 5). It clears up contradictions but doesn't say it was wrong. `evals/probe.ts` replays these moments.

These scripts are in `evals/scenarios/scripts.ts`. **The scripted learner never asks Lena anything, which is why the earlier evals missed all of this.**

## Still wrong

- **German errors remain, even in E4B:** "Und dir geht es heute wie?", "Ich habe viel am See spazieren gegangen". This is serious for learners, who may copy them. A lexicon check would catch misspellings, but not grammar.
- **Lena contradicts herself:** she has a grandmother, children, or took Bruno to the cinema. Saving what she says, planned for Phase 3, should reduce this. It may need a stronger prompt as well.
- **Some questions are odd or misread context:** "Wie groß sind denn deine Tomaten?" about the father's tomatoes.
- **Unexplained stalls:** earlier runs had occasional 3–8 s replies on models that normally take under 0.5 s. The final run had none, but the cause was never found. The GPU was busy with something else at the time, so it may be outside the app. Watch for this on Windows.
- **Vocabulary level isn't checked yet:** only sentence length and a readability score are. No GPL-compatible CEFR list is confirmed: DAFlex states no licence on its page.

## Voices: engine chosen, voice not yet

Blind test built by `evals/listening/build.py`, rated by one listener (out of 5):

| Voice | Natural | Clear | Slow speed OK | Total /15 |
|---|---|---|---|---|
| Pocket TTS `juergen` (`german`) | 5 | 5 | 3 | 13 |
| Piper Thorsten (medium) | 3 | 5 | 4 | 12 |
| Pocket TTS `juergen` (`german_24l`) | 4 | 5 | 2 | 11 |
| Piper Pavoque (low) | 2 | 4 | 4 | 10 |
| Piper Karlsson (low) | 3 | 4 | 2 | 9 |
| Piper Thorsten (high) | 2 | 4 | 2 | 8 |
| Piper Kerstin (low) | 2 | 4 | 2 | 8 |
| Piper Ramona (low) | 2 | 3 | 2 | 7 |
| Piper Eva K. (x_low) | 1 | 1 | 2 | 4 |
| Piper MLS (medium) | 1 | 1 | 1 | 3 |

**Decision: Pocket TTS with the `german` model.** The larger 24-layer model scored lower and is slower, so it's dropped. Piper Thorsten (medium) stays as the fallback if Pocket TTS fails on Windows.

**Speed of the shipped binary:** on Windows, 1.9–3.1 s of speech took 0.24–0.42 s in total with the server running, about 8x real time. Loading took 17 s the first time, including a download.

**Time to first audio**, measured with the Python package under WSL with nothing else competing for the CPU:

| Threads | First audio (median) | Speed |
|---|---|---|
| 2 | 94 ms | 2.5–3.1x real time |
| 4 | 63 ms | 3.2–4.6x real time |
| 8 | 60 ms | 4.1–5.7x real time |

All of this is well inside the latency budget, but this is a fast CPU.

**Decision: the first character is a man, using `juergen`.** It's the only dedicated German voice, and the user preferred this over testing voices from English speech. `build_round2.py` remains if a female character is added later.

**Slow speech is deprioritised at the user's request.** The model has no speed setting, and plain time-stretching only scored 3, which is acceptable for now. A comparison page exists at `listening-round2/slow/` if this comes back.

**Licences:**

- The weights are CC BY 4.0 per Kyutai's model pages, so attribution is required.
- Kyutai's `pocket-tts-without-voice-cloning` repository isn't gated, unlike the cloning one, so users won't need an account. Cloning isn't needed.
- Kyutai's voice page marks Expresso and EARS data as non-commercial, so voices from those (`cosette`, `jean`) were left out. Alba is CC BY 4.0. The licences for `juergen` and the VCTK-based voices are still unconfirmed.
- Pocket TTS bans voice impersonation without consent and passing off audio as real recordings. Neither applies here, but the app shouldn't add voice cloning casually.

**Piper notes:** Kokoro has no German voices, so it was never tested. Piper's speed setting isn't linear (a setting of 1.25 lengthens speech by only 10–13%), so it would need calibrating per voice if used as the fallback. Calibrated slow clips came out 14–34% longer than normal.

## Speech recognition

whisper.cpp publishes **no Vulkan build**, only CPU and NVIDIA CUDA, which corrects the plan. Measured on Windows on the CPU, 8 threads, with the server already running:

| Model | Time per sentence | Heard (3 clean sentences) |
|---|---|---|
| `base` | 0.53–0.59 s | Lost part of one ("auf jeden Fall schwer ist") |
| `small` | 1.95–2.04 s | One lost its first word ("dich kennen zu lernen") |

`large-v3-turbo` took about 15 s per sentence under WSL, so it isn't usable on a CPU.

The round trip from the end of a turn to Jonas's first audio, measured under WSL with E4B: `base` plus speech gate 1.36 s median (worst 1.46 s), `small` 4.28 s without the gate. Windows ran these models about a third faster, but the full round trip hasn't been run there. `small` is the more accurate on the longer WSL test (8 of 8, against 6 of 8 for `base`), though the test speech differs each run, and none of this is real learner speech.

**Decision (revised after the user's first real session):** on NVIDIA cards, `large-v3-turbo` on the GPU using whisper.cpp's CUDA build. Otherwise `base` on the CPU, which is also the fallback if the GPU build fails.

The user's session showed `base` garbling real speech ("du abatest dann bei der Bekäre", "Wir heißt die"), so Jonas was often answering nonsense. Part of what felt like a weak LLM was weak hearing.

Measured on Windows on synthetic speech with added noise:

| Whisper | Time per sentence | Graphics memory | Result |
|---|---|---|---|
| `base`, CPU | 0.47 s | none | "jeden Tag wübst, auf wenn es manchmal" |
| `base`, GPU | 0.06 s | 0.3 GB | Same mistakes |
| `small`, GPU | 0.09 s | 0.6 GB | Lost a first word |
| `large-v3-turbo`, GPU | 0.13 s | 1.0 GB | All correct |

The NVIDIA build is a 653 MB download. AMD and Intel GPUs still have no prebuilt option, so a self-built Vulkan whisper.cpp would be the next thing to try for them. Accuracy on real speech with the new model hasn't been checked.

**Whisper invents text from silence, as predicted.** Pure silence and noise gave `[MUSIK]`, "Vielen Dank.", "Amen.", and `[Wir haben ein Video von dem Video gemacht…]`.

- `--suppress-nst` made it **worse**, turning labels into believable sentences ("Wir haben heute einen neuen Kurs."), so it must stay off.
- The Silero speech gate (`--vad`) returned nothing for silence and for both noise levels, on Linux and Windows. It may clip the start of speech, as in the `small` result above, so check its padding on real recordings.
- `cleanTranscript` removes labels and known phrases as a second layer.

## Turn-taking: top priority

The user's main requirement is that the partner never jumps in while they're forming a sentence. `packages/engine/src/turns.ts` implements this as logic, tested without audio.

**Decision: turn-by-turn is the default mode.** The user ends their own turn, so an interruption can't come from a timer or a misjudged pause, and it doesn't depend on detection quality. The hands-free `patient` mode stays off by default until real recordings show it meets the under-5% cutoff target.

This also changes the plan's order: the first voice version no longer waits on recordings.

## Bigger LLMs on 8 GB

Measured in the full app, with Whisper on the same GPU (`npm run windows -- --model <name>`). First audio after the turn ended:

| Model | First audio | Notes |
|---|---|---|
| Gemma 4 E4B (default) | 0.63–1.22 s | |
| Qwen 3.5 9B | 4.3–4.5 s | Took 0.6 s alone, so sharing the card with Whisper costs a lot. Its German isn't clearly better |
| Gemma 4 12B, 22 layers on the GPU | 3.7–7.6 s | Reads a little better |

Few replies were sampled, and the test's fake microphone interrupts itself, so treat these as rough. The user chooses whether better replies are worth the wait.

**Disk:** WSL's disk is a file on C: (100 GB here), so "free space" inside WSL isn't real. C: fell from about 31 GB to 14 GB free during testing, and the page file grew to 17.5 GB. `run-on-windows` now refuses copies that would leave under 5 GB free.

**Orphaned programs:** when the app is killed outright, its helper programs keep running and hold the GPU. The app now records them and stops them on its next start. That path hasn't been tested with a real crash.

## Tom, the English partner (0.2.0)

Tom is a geography teacher from Nottingham, for B2 and C1, using the Pocket TTS voice `paul`. The user chose him by blind listening, rating `paul` 14/15 against nine male voices. `jean` was left out, because its EARS recordings are non-commercial only.

**Conversation** (`npm run eval -- --partner tom --levels B2,C1`), 60 turns per model:

- No closing phrases spoken, and no dodged questions.
- He asked questions in about 41% of replies.
- The British English reads naturally ("a proper page-turner", "no bother at all, happens to the best of us").

Weak spots:
- Some follow-ups are bland tag questions ("It's funny how things go, isn't it?").
- He once called Hamburg "quite a change from Nottingham", for a learner who isn't from there.

**Probes** (`evals/probe.ts --partner tom`):
- **E4B:** corrected all 9 false-premise tries (cat, Germany trip, wrong job), and agreed when the premise was true. Challenged on a contradiction, he admitted it 2 times out of 3. The third time he said "you must have misremembered".
- **E2B:** comparable. When a learner apologised for their English, both models reassured them without lecturing.

**"How could I say that better?"** (`evals/feedback.ts`), with 20 correct sentences and 20 learner mistakes, each 3 times:

| Model | False alarms on correct sentences | Mistakes caught | Right fix |
|---|---|---|---|
| E4B | 3/60, all one comma; now ignored in code | 60/60 | 60/60 |
| E2B | 25/60 | 60/60 | 56/60 |

**Decision:** feedback only appears on E4B or better. For anxious learners, a correct sentence called wrong is the worst outcome. Jonas has no feedback, since German quality hasn't been checked.

**Turn-taking changed at the user's request:** after the partner speaks, nothing is recorded until the learner presses **Start speaking**, and **Hear again** replays the reply. Recording stops at **I'm done**, after a test showed sound afterwards could cancel the reply and repeat the turn.

**Windows tests:**
- Both partners ran end to end. Tom's voice downloaded on first use.
- Switching from Jonas to Tom mid-session worked, taking about 9.5 s.
- Installing 0.2.0 over 0.1.0 kept the downloads and the saved partner, and uninstalling removed everything.
- First audio was 0.9–1.8 s after the turn ended.

**Untested:** feedback in the app itself (only via the eval), a real microphone with the two-step turn, and Tom on non-NVIDIA machines.

Whisper set to English translates German speech into English rather than transcribing it, as seen when a German test clip reached Tom.

## Installer

`npm run package` builds `release/Conversationer-Setup-0.1.0.exe` (161 MB, unsigned). Models aren't included: the app chooses and downloads them on first run, after asking, with hash checks and resuming. Models come from Google's and whisper.cpp's public pages, pinned by revision and hash.

Tested on the development machine with `evals/test-installer.py`, not on a clean PC, since Windows Sandbox is disabled there:

- Installed in 21 s (555 MB). Nothing downloads before consent.
- A real first run took 9.3 minutes on this connection and used 7.4 GB, then held a conversation with Google's Gemma files. They differ from Ollama's copies by about 2 KB, but replies read the same on the prompts checked, at 408 ms to first sentence.
- The app restarted and ran with its internet blocked by a proxy, which isn't the same as a disconnected PC.
- The download button starts the download, and a failed download offers "Try again". Resuming after that is only tested in the downloader's unit tests.
- Uninstalling removes the app, the models and the data.

The app was killed outright, but no helper programs outlived it in that test, so the leftover cleanup hasn't run against live leftovers.

The final build differs from the one that had the full run only by a test hook and an uninstall cleanup. It was retested for install, the download button, a failed download and uninstall.

**Not tested:** any other computer, AMD or Intel dedicated GPUs, older NVIDIA drivers, and SmartScreen's warning. On non-NVIDIA machines the hearing falls back to `base`, the model that garbled the user's speech.

## First voice version

`apps/desktop` runs on Windows with `npm run windows` from WSL. `npm run windows -- --autotest` plays a conversation with a sound file as the microphone, and its log and screenshot land in `%LOCALAPPDATA%\conversationer-dev\logs`.

Measured in that autotest on the RTX 5070, first with E4B and Whisper `base`: first audio 1.06–1.19 s after the turn ended, inside the 1.5 s target. See the table above for the GPU Whisper. All three programs start, shut down cleanly, and the fake speech was transcribed correctly in both turns.

**Not tested yet:** a real microphone, real echo from speakers, and the loudness threshold for detecting speech. Those need a person.

**Deliberate limits for now:**

- While Jonas talks, the microphone is ignored, so the user stops him with a button, not by talking. His voice can't be mistaken for theirs, but late-continuation recovery only works while he's thinking.
- Speculative generation isn't used yet. There's no memory between sessions, and no installer or model downloads. This is a developer run.

## Not started: needs real recordings

These now only decide whether hands-free mode can be offered, except for Whisper accuracy, which matters in every mode.


Whisper accuracy, silence hallucinations, filler handling, grammar normalisation, Smart Turn on hesitant speech, and the patience timers all need 20+ recordings of hesitant, accented German. Synthetic speech wouldn't test what matters here.
