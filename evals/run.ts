/**
 * LLM bake-off: plays every scripted learner against every model and writes metrics and transcripts.
 *
 *   npm run eval -- --models gemma4:e4b-it-qat,qwen3.5:4b-q4_K_M [--levels A1,A2] [--turns 50] [--out evals/results/name]
 *   npm run eval -- --models gemma4:e4b-it-qat --levels A2 --script real-conversation
 *
 * Talks to any OpenAI-compatible server. Against Ollama it also records how the model was loaded.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { partnerById } from '../languages/partners.ts';
import { generateTurn, openAiCompatibleChat, personaTurn } from '../packages/engine/src/index.ts';
import type { CefrLevel, Turn } from '../packages/engine/src/index.ts';
import { computeMetrics, type Metrics, type RecordedTurn } from './metrics.ts';
import { learners } from './scenarios/learners.ts';
import { englishLearners } from './scenarios/learners-en.ts';
import { scripts } from './scenarios/scripts.ts';

const { values } = parseArgs({
  options: {
    models: { type: 'string' },
    levels: { type: 'string', default: 'A1,A2,B1' },
    turns: { type: 'string', default: '50' },
    script: { type: 'string' },
    partner: { type: 'string', default: 'jonas' },
    base: { type: 'string', default: 'http://localhost:11434' },
    out: { type: 'string', default: `evals/results/${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}` },
  },
});
if (!values.models) throw new Error('--models is required');
const models = values.models.split(',');
const partner = partnerById(values.partner);
if (!partner) throw new Error(`Unknown partner ${values.partner}`);
const { pack, persona } = partner;
const scriptedLearners = partner.id === 'tom' ? englishLearners : learners;
const levels = values.levels.split(',') as CefrLevel[];
const maxTurns = Number(values.turns);

interface Loaded {
  sizeGb: number;
  gpuPct: number;
}

/** Ollama only. Returns undefined against other servers. */
async function loadedModel(base: string, model: string): Promise<Loaded | undefined> {
  const response = await fetch(`${base}/api/ps`).catch(() => undefined);
  if (!response?.ok) return undefined;
  const { models: running } = (await response.json()) as { models: { name: string; size: number; size_vram: number }[] };
  const entry = running.find((m) => m.name === model);
  if (!entry) return undefined;
  return { sizeGb: entry.size / 1e9, gpuPct: (100 * entry.size_vram) / entry.size };
}

async function unload(base: string, model: string): Promise<void> {
  await fetch(`${base}/api/generate`, { method: 'POST', body: JSON.stringify({ model, keep_alive: 0 }) }).catch(() => undefined);
}

async function playConversation(model: string, level: CefrLevel): Promise<RecordedTurn[]> {
  const chat = openAiCompatibleChat(values.base, model);
  const lines = values.script ? scripts[values.script] : scriptedLearners[level];
  if (!lines) throw new Error(`No lines for ${values.script ?? level}`);

  const history: Turn[] = [];
  const recorded: RecordedTurn[] = [];
  for (const [index, line] of lines.slice(0, maxTurns).entries()) {
    history.push({ speaker: 'user', text: line });
    const started = performance.now();
    let firstSentenceMs = 0;
    const result = await generateTurn(
      { history, level, pack, persona, memory: {}, chat },
      {
        onSentence: () => {
          firstSentenceMs ||= performance.now() - started;
        },
      },
    );
    recorded.push({ ...result, user: line, firstSentenceMs, totalMs: performance.now() - started });
    history.push(personaTurn(result));
    process.stderr.write(`  ${level} ${index + 1}/${Math.min(lines.length, maxTurns)}\r`);
  }
  process.stderr.write('\n');
  return recorded;
}

function transcript(model: string, level: CefrLevel, turns: RecordedTurn[]): string {
  const lines = [`# ${persona.name}, ${model} at ${level}`, ''];
  for (const turn of turns) {
    lines.push(`**Learner:** ${turn.user}`, '');
    const notes: string[] = [turn.direction.move, turn.direction.questionStyle];
    if (turn.usedFallback) notes.push('FALLBACK');
    if (turn.addedHook) notes.push('ADDED HOOK');
    lines.push(`**Jonas** (${notes.join(', ')}, ${Math.round(turn.firstSentenceMs)} ms): ${turn.reply}`, '');
    for (const { sentence, violations } of turn.rejected) lines.push(`- removed [${violations.join(', ')}]: ${sentence}`);
    if (turn.rejected.length > 0) lines.push('');
  }
  return lines.join('\n');
}

function summaryTable(rows: { model: string; level: CefrLevel; metrics: Metrics; loaded?: Loaded }[]): string {
  const header =
    '| Model | Level | Closers tried / spoken | Within level | Dead ends | Fallback | Added hook | Removed per turn | Distinct openers | Parrot | Asks | Answered with a question | Repeats | Reply words | User share | LIX | First sentence p50 / p95 | Memory (GPU) |';
  const divider = `|${'---|'.repeat(18)}`;
  const body = rows.map(({ model, level, metrics: m, loaded }) =>
    [
      model,
      level,
      `${m.closingPhrasesAttempted} / ${m.closingPhrasesSpoken}`,
      `${m.withinLevelPct}%`,
      m.deadEnds,
      `${m.fallbackPct}%`,
      `${m.addedHookPct}%`,
      m.rejectedSentencesPerTurn,
      `${m.distinctOpenersPct}%`,
      `${m.parrotPct}%`,
      `${m.asksPct}%`,
      m.dodgedQuestions,
      m.exactRepeats,
      m.meanReplyWords,
      `${m.userWordSharePct}%`,
      m.lix,
      `${m.firstSentenceMsP50} / ${m.firstSentenceMsP95} ms`,
      loaded ? `${loaded.sizeGb.toFixed(1)} GB (${loaded.gpuPct.toFixed(0)}%)` : 'n/a',
    ].join(' | '),
  );
  return [header, divider, ...body.map((row) => `| ${row} |`)].join('\n');
}

mkdirSync(values.out, { recursive: true });
const rows: Parameters<typeof summaryTable>[0] = [];

for (const model of models) {
  console.error(`=== ${model}`);
  // The first reply includes loading the model, which is a startup cost and not conversation latency.
  const warmup = openAiCompatibleChat(values.base, model);
  for await (const _ of warmup([{ role: 'user', content: 'Hallo' }], { temperature: 0, maxTokens: 8 })) {
    // Drain the stream.
  }
  const loaded = await loadedModel(values.base, model);

  for (const level of levels) {
    const turns = await playConversation(model, level);
    const metrics = computeMetrics(turns, level, pack);
    rows.push({ model, level, metrics, loaded });
    const stem = `${model.replace(/[^\w.-]+/g, '_')}.${level}`;
    writeFileSync(join(values.out, `${stem}.md`), transcript(model, level, turns));
    writeFileSync(join(values.out, `${stem}.json`), JSON.stringify({ metrics, loaded, turns }, null, 2));
  }
  await unload(values.base, model);
  writeFileSync(join(values.out, 'summary.md'), `${summaryTable(rows)}\n`);
}
console.log(summaryTable(rows));
console.error(`\nResults in ${values.out}`);
