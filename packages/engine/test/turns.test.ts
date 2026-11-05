import { describe, expect, it } from 'vitest';
import { german } from '../../../languages/de/index.ts';
import { PATIENCE, TurnController } from '../src/index.ts';
import type { TurnMode, TurnOptions } from '../src/index.ts';

function controller(mode: TurnMode, options: Partial<TurnOptions> = {}) {
  return new TurnController({
    mode,
    patience: PATIENCE.gentle,
    soundsUnfinished: german.soundsUnfinished,
    speculate: 'always',
    ...options,
  });
}

/** Ticks every 100 ms across a span of time and collects every command issued. */
function waitUntil(turns: TurnController, from: number, to: number) {
  const commands = [];
  for (let at = from; at <= to; at += 100) commands.push(...turns.handle({ type: 'tick', at }));
  return commands;
}

describe('turn-by-turn mode: the guarantee', () => {
  it('never commits on silence, however long the pause', () => {
    const turns = controller('turn_by_turn');
    turns.handle({ type: 'speech_start', at: 0 });
    turns.handle({ type: 'speech_end', at: 1000 });
    turns.handle({ type: 'end_of_turn_score', score: 1 });
    turns.handle({ type: 'transcript', text: 'Das ist alles.' });
    const commands = waitUntil(turns, 1000, 600_000);
    expect(commands).not.toContain('commit_turn');
    expect(commands).not.toContain('play_reply');
    expect(turns.state).toBe('paused');
  });

  it('keeps a finished reply silent until the user ends their turn', () => {
    const turns = controller('turn_by_turn');
    turns.handle({ type: 'speech_start', at: 0 });
    turns.handle({ type: 'speech_end', at: 1000 });
    expect(turns.handle({ type: 'reply_ready' })).toEqual([]);
    expect(waitUntil(turns, 1000, 60_000)).not.toContain('play_reply');
    expect(turns.handle({ type: 'done', at: 60_000 })).toEqual(['commit_turn', 'play_reply']);
  });

  it('ignores "done" when nothing has been said', () => {
    const turns = controller('turn_by_turn');
    expect(turns.handle({ type: 'done', at: 500 })).toEqual([]);
    expect(turns.state).toBe('listening');
  });

  it('lets the user finish while still speaking', () => {
    const turns = controller('turn_by_turn');
    turns.handle({ type: 'speech_start', at: 0 });
    expect(turns.handle({ type: 'done', at: 800 })).toEqual(['commit_turn']);
    expect(turns.state).toBe('ai_thinking');
  });
});

describe('patient mode', () => {
  const pause = (turns: TurnController, at = 1000) => {
    turns.handle({ type: 'speech_start', at: at - 1000 });
    return turns.handle({ type: 'speech_end', at });
  };

  it('waits the long timer when there is no signal the user has finished', () => {
    const turns = controller('patient');
    pause(turns);
    expect(waitUntil(turns, 1000, 8900)).not.toContain('commit_turn');
    expect(waitUntil(turns, 9000, 9100)).toContain('commit_turn');
  });

  it('commits sooner when the user sounds finished', () => {
    const turns = controller('patient');
    pause(turns);
    turns.handle({ type: 'transcript', text: 'Ich war heute im Park.' });
    turns.handle({ type: 'end_of_turn_score', score: 0.9 });
    expect(waitUntil(turns, 1000, 3400)).not.toContain('commit_turn');
    expect(waitUntil(turns, 3500, 3600)).toContain('commit_turn');
  });

  it('trusts an unfinished sentence over intonation', () => {
    const turns = controller('patient');
    pause(turns);
    turns.handle({ type: 'transcript', text: 'Ich gehe in die' });
    turns.handle({ type: 'end_of_turn_score', score: 0.9 });
    expect(waitUntil(turns, 1000, 8900)).not.toContain('commit_turn');
  });

  it('treats "Ich gehe in die…", a long pause, then the rest as one turn', () => {
    const turns = controller('patient');
    pause(turns);
    turns.handle({ type: 'transcript', text: 'Ich gehe in die' });
    expect(waitUntil(turns, 1000, 7000)).not.toContain('commit_turn');
    expect(turns.handle({ type: 'speech_start', at: 7000 })).toEqual(['cancel_speculation']);
    expect(turns.state).toBe('user_speaking');
  });

  it('has no timer at all before the first word', () => {
    const turns = controller('patient');
    const commands = waitUntil(turns, 0, 120_000);
    expect(commands).toEqual(['show_hint']);
    expect(turns.state).toBe('listening');
  });

  it('offers the hint only after 30 seconds, and removes it on speech', () => {
    const turns = controller('patient');
    expect(waitUntil(turns, 0, 29_900)).toEqual([]);
    expect(waitUntil(turns, 30_000, 30_000)).toEqual(['show_hint']);
    expect(turns.handle({ type: 'speech_start', at: 31_000 })).toEqual(['hide_hint']);
  });

  it('holds the turn open while "Moment…" is on', () => {
    const turns = controller('patient');
    pause(turns);
    turns.handle({ type: 'hold', on: true });
    expect(waitUntil(turns, 1000, 300_000)).not.toContain('commit_turn');
    turns.handle({ type: 'hold', on: false });
    expect(turns.handle({ type: 'tick', at: 300_100 })).toContain('commit_turn');
  });

  it('never exceeds the hard limit, even for very long learned pauses', () => {
    const turns = controller('patient');
    let at = 0;
    for (let i = 0; i < 10; i++) {
      turns.handle({ type: 'speech_start', at });
      at += 1000;
      turns.handle({ type: 'speech_end', at });
      at += 60_000;
    }
    turns.handle({ type: 'speech_start', at });
    turns.handle({ type: 'speech_end', at: at + 1000 });
    expect(waitUntil(turns, at + 1000, at + 15_900)).not.toContain('commit_turn');
    expect(waitUntil(turns, at + 16_000, at + 16_100)).toContain('commit_turn');
  });

  it('gives more time to someone who habitually pauses longer', () => {
    const turns = controller('patient');
    let at = 0;
    for (let i = 0; i < 6; i++) {
      turns.handle({ type: 'speech_start', at });
      at += 1000;
      turns.handle({ type: 'speech_end', at });
      at += 7000; // Under the 8 s timer, so each pause ends with the user carrying on.
    }
    turns.handle({ type: 'speech_start', at });
    turns.handle({ type: 'speech_end', at: at + 1000 });
    turns.handle({ type: 'transcript', text: 'Ich war heute im Park.' });
    turns.handle({ type: 'end_of_turn_score', score: 0.9 });
    // Sounding finished would normally mean 2.5 s. This user gets 7 s x 1.25.
    expect(waitUntil(turns, at + 1000, at + 9700)).not.toContain('commit_turn');
    expect(waitUntil(turns, at + 9800, at + 9900)).toContain('commit_turn');
  });
});

describe('speculation', () => {
  it('starts work at a pause so a long wait adds no delay at the end', () => {
    const turns = controller('patient');
    turns.handle({ type: 'speech_start', at: 0 });
    expect(turns.handle({ type: 'speech_end', at: 1000 })).toEqual(['begin_speculation']);
  });

  it('plays nothing until commit, then plays at once', () => {
    const turns = controller('patient');
    turns.handle({ type: 'speech_start', at: 0 });
    turns.handle({ type: 'speech_end', at: 1000 });
    expect(turns.handle({ type: 'reply_ready' })).toEqual([]);
    expect(waitUntil(turns, 1000, 8900)).not.toContain('play_reply');
    expect(waitUntil(turns, 9000, 9100)).toEqual(['commit_turn', 'play_reply']);
  });

  it('does not play a reply prepared before the user carried on', () => {
    const turns = controller('patient');
    turns.handle({ type: 'speech_start', at: 0 });
    turns.handle({ type: 'speech_end', at: 1000 });
    turns.handle({ type: 'reply_ready' });
    turns.handle({ type: 'speech_start', at: 2000 });
    turns.handle({ type: 'speech_end', at: 3000 });
    const commands = waitUntil(turns, 3000, 11_000);
    expect(commands).toContain('commit_turn');
    expect(commands).not.toContain('play_reply');
    expect(turns.state).toBe('ai_thinking');
  });

  it('on low-end machines only speculates once the user sounds finished', () => {
    const turns = controller('patient', { speculate: 'when_finished' });
    turns.handle({ type: 'speech_start', at: 0 });
    expect(turns.handle({ type: 'speech_end', at: 1000 })).toEqual([]);
    turns.handle({ type: 'transcript', text: 'Ich war heute im Park.' });
    turns.handle({ type: 'end_of_turn_score', score: 0.9 });
    expect(turns.handle({ type: 'tick', at: 1100 })).toEqual(['begin_speculation']);
  });
});

describe('when the user speaks after the turn ended', () => {
  const toThinking = () => {
    const turns = controller('turn_by_turn');
    turns.handle({ type: 'speech_start', at: 0 });
    turns.handle({ type: 'speech_end', at: 1000 });
    turns.handle({ type: 'done', at: 2000 });
    return turns;
  };

  it('drops the reply and keeps listening if they carry on before it plays', () => {
    const turns = toThinking();
    expect(turns.handle({ type: 'speech_start', at: 2500 })).toEqual(['cancel_speculation', 'merge_with_previous_turn']);
    expect(turns.state).toBe('user_speaking');
    expect(turns.handle({ type: 'reply_ready' })).toEqual([]);
  });

  it('stops at once and merges if they speak just after the persona starts', () => {
    const turns = toThinking();
    expect(turns.handle({ type: 'reply_ready' })).toEqual(['play_reply']);
    turns.handle({ type: 'playback_started', at: 3000 });
    expect(turns.handle({ type: 'speech_start', at: 3800 })).toEqual(['stop_playback', 'merge_with_previous_turn']);
  });

  it('treats later speech as interrupting, and starts a new turn', () => {
    const turns = toThinking();
    turns.handle({ type: 'reply_ready' });
    turns.handle({ type: 'playback_started', at: 3000 });
    expect(turns.handle({ type: 'speech_start', at: 6000 })).toEqual(['stop_playback']);
    expect(turns.state).toBe('user_speaking');
  });

  it('goes back to listening with no timer when the persona finishes', () => {
    const turns = toThinking();
    turns.handle({ type: 'reply_ready' });
    turns.handle({ type: 'playback_started', at: 3000 });
    turns.handle({ type: 'playback_finished', at: 5000 });
    expect(turns.state).toBe('listening');
    expect(waitUntil(turns, 5000, 34_900)).toEqual([]);
  });
});

describe('around the conversation', () => {
  it('lets the persona open, then listens', () => {
    const turns = controller('turn_by_turn');
    turns.handle({ type: 'persona_starts' });
    expect(turns.handle({ type: 'reply_ready' })).toEqual(['play_reply']);
    turns.handle({ type: 'playback_finished', at: 1000 });
    expect(turns.state).toBe('listening');
  });

  it('goes back to listening when a turn held nothing, with the wait starting afresh', () => {
    const turns = controller('turn_by_turn');
    turns.handle({ type: 'speech_start', at: 0 });
    turns.handle({ type: 'done', at: 500 });
    turns.handle({ type: 'turn_discarded', at: 1000 });
    expect(turns.state).toBe('listening');
    expect(waitUntil(turns, 1000, 30_900)).toEqual([]);
    expect(turns.handle({ type: 'tick', at: 31_000 })).toEqual(['show_hint']);
  });
});

describe('German: does this sound unfinished?', () => {
  it.each([
    'Ich gehe in die',
    'Ich war gestern mit meinem',
    'Ich mag Pizza und',
    'Ich bin müde, aber',
    'Ich habe',
    'weil ich gestern',
    'Ich bleibe zu Hause, weil ich heute',
    'Ich weiß, dass du',
    'Wenn ich morgen nicht',
    'ähm',
    'Ich äh',
    '',
  ])('unfinished: "%s"', (text) => {
    expect(german.soundsUnfinished(text)).toBe(true);
  });

  it.each([
    'Ich war heute im Park.',
    'Ich gehe nach Hause',
    'Ich bleibe zu Hause, weil ich müde bin',
    'Ich weiß, dass du kochst',
    'Ja',
    'Danke',
    'Ich mag Pizza',
    'Das ist alles.',
  ])('finished: "%s"', (text) => {
    expect(german.soundsUnfinished(text)).toBe(false);
  });
});
