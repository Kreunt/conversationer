import { describe, expect, it } from 'vitest';
import { llmChoices, parseDevices, whisperChoices } from '../src/index.ts';

// Real output from this project's test machine.
const LAPTOP = `Available devices:
  Vulkan0: NVIDIA GeForce RTX 5070 Laptop GPU (7891 MiB, 7123 MiB free)
  Vulkan1: Intel(R) RaptorLake-S Mobile Graphics Controller (16239 MiB, 15471 MiB free)
`;

describe('parseDevices', () => {
  it('reads real llama-server output', () => {
    expect(parseDevices(LAPTOP)).toEqual([
      { id: 'Vulkan0', name: 'NVIDIA GeForce RTX 5070 Laptop GPU', totalMib: 7891, freeMib: 7123 },
      { id: 'Vulkan1', name: 'Intel(R) RaptorLake-S Mobile Graphics Controller', totalMib: 16239, freeMib: 15471 },
    ]);
  });

  it('copes with no devices', () => {
    expect(parseDevices('Available devices:\n  (none)\n')).toEqual([]);
  });
});

describe('llmChoices', () => {
  const gpu = (name: string, freeMib: number) => ({ id: 'Vulkan0', name, totalMib: freeMib, freeMib });

  it('prefers the dedicated GPU, even with far less memory than the integrated one', () => {
    expect(llmChoices(parseDevices(LAPTOP))[0]).toEqual({ model: 'gemma4-e4b-it-qat', device: 'Vulkan0' });
  });

  it('steps down from E4B to E2B to the CPU', () => {
    expect(llmChoices(parseDevices(LAPTOP))).toEqual([
      { model: 'gemma4-e4b-it-qat', device: 'Vulkan0' },
      { model: 'gemma4-e2b-it-qat', device: 'Vulkan0' },
      { model: 'gemma4-e2b-it-qat', device: 'none' },
    ]);
  });

  it('uses the small model when the GPU is short of memory', () => {
    expect(llmChoices([gpu('NVIDIA GeForce GTX 1650', 3000)])[0]).toEqual({ model: 'gemma4-e2b-it-qat', device: 'Vulkan0' });
  });

  it('falls back to the CPU when the GPU has too little memory', () => {
    expect(llmChoices([gpu('NVIDIA GeForce GT 1030', 1500)])).toEqual([{ model: 'gemma4-e2b-it-qat', device: 'none' }]);
  });

  it.each(['Intel(R) UHD Graphics', 'Intel(R) Iris(R) Xe Graphics', 'AMD Radeon(TM) Graphics', 'llvmpipe (LLVM 15)', 'Microsoft Basic Render Driver'])(
    'never picks %s',
    (name) => {
      expect(llmChoices([gpu(name, 16000)])).toEqual([{ model: 'gemma4-e2b-it-qat', device: 'none' }]);
    },
  );

  it('uses the CPU on a machine with no GPU at all', () => {
    expect(llmChoices([])).toEqual([{ model: 'gemma4-e2b-it-qat', device: 'none' }]);
  });
});

describe('whisperChoices', () => {
  const nvidia = (freeMib: number) => [{ id: 'Vulkan0', name: 'NVIDIA GeForce RTX 5070', totalMib: 8000, freeMib }];
  const cpuOnly = { build: 'whisper', model: 'ggml-base-q5_1.bin' };
  const gpu = { build: 'whisper-cuda', model: 'ggml-large-v3-turbo-q5_0.bin' };

  it('uses the large model on an NVIDIA card, stepping down to the CPU if that fails', () => {
    expect(whisperChoices(parseDevices(LAPTOP), { model: 'gemma4-e4b-it-qat', device: 'Vulkan0' })).toEqual([gpu, cpuOnly]);
  });

  it('leaves room for the LLM on the same card', () => {
    expect(whisperChoices(nvidia(4000), { model: 'gemma4-e4b-it-qat', device: 'Vulkan0' })).toEqual([cpuOnly]);
    expect(whisperChoices(nvidia(4000), { model: 'gemma4-e2b-it-qat', device: 'Vulkan0' })).toEqual([gpu, cpuOnly]);
  });

  it('can use the card when the LLM is on the CPU', () => {
    expect(whisperChoices(nvidia(2000), { model: 'gemma4-e2b-it-qat', device: 'none' })).toEqual([gpu, cpuOnly]);
  });

  it('assumes a model it has no figures for needs the whole card', () => {
    expect(whisperChoices(nvidia(7000), { model: 'some-new-model', device: 'Vulkan0' })).toEqual([cpuOnly]);
  });

  it('uses the CPU without an NVIDIA card', () => {
    const amd = [{ id: 'Vulkan0', name: 'AMD Radeon RX 7600', totalMib: 8000, freeMib: 7000 }];
    expect(whisperChoices(amd, { model: 'gemma4-e4b-it-qat', device: 'Vulkan0' })).toEqual([cpuOnly]);
  });
});
