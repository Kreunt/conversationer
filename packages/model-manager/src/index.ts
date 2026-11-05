/** Chooses models from what the machine actually has. The thresholds come from evals/PHASE0.md. */

export interface GpuDevice {
  /** The name to pass to llama-server, e.g. "Vulkan0". */
  id: string;
  name: string;
  totalMib: number;
  freeMib: number;
}

export interface LlmChoice {
  /** The model file, without its extension. */
  model: string;
  /** A device id, or "none" for the CPU. */
  device: string;
  /** How many layers go on the GPU, when the whole model doesn't fit. */
  gpuLayers?: number;
}

// Integrated graphics report plenty of shared memory but ran three times slower than the CPU.
const INTEGRATED = /\b(?:intel|uhd|iris|radeon\(tm\) graphics|radeon graphics|vega \d+ graphics|microsoft basic|llvmpipe|software)\b/i;

/** Measured use plus room for the context. */
const E4B_NEEDS_MIB = 3600;
const E2B_NEEDS_MIB = 2000;

const WHISPER_GPU_NEEDS_MIB = 1200;
/** Room for the LLM on the same card, by model. */
const LLM_NEEDS_MIB: Record<string, number> = {
  'gemma4-e4b-it-qat': E4B_NEEDS_MIB,
  'gemma4-e2b-it-qat': E2B_NEEDS_MIB,
  // Measured for the comparison models: Qwen 9B whole, and Gemma 12B with 22 layers on the GPU.
  'qwen3.5-9b-q4': 5400,
  'gemma4-12b-it-qat': 4200,
};

export interface WhisperChoice {
  /** The folder holding the build to run. */
  build: 'whisper-cuda' | 'whisper';
  model: 'ggml-large-v3-turbo-q5_0.bin' | 'ggml-base-q5_1.bin';
}

/**
 * On an NVIDIA card with memory to spare, the large model is both more accurate and faster than the
 * small one on the CPU. whisper.cpp publishes no build for other GPUs. Best first, so a failure can step down.
 */
export function whisperChoices(devices: GpuDevice[], llm: LlmChoice): WhisperChoice[] {
  const cpu: WhisperChoice = { build: 'whisper', model: 'ggml-base-q5_1.bin' };
  const nvidia = devices.find((device) => /nvidia/i.test(device.name));
  if (!nvidia) return [cpu];
  const sharedWithLlm = llm.device === nvidia.id ? (LLM_NEEDS_MIB[llm.model] ?? nvidia.freeMib) : 0;
  if (nvidia.freeMib - sharedWithLlm < WHISPER_GPU_NEEDS_MIB) return [cpu];
  return [{ build: 'whisper-cuda', model: 'ggml-large-v3-turbo-q5_0.bin' }, cpu];
}

/** Parses the output of `llama-server --list-devices`. */
export function parseDevices(output: string): GpuDevice[] {
  const devices: GpuDevice[] = [];
  for (const match of output.matchAll(/^\s*(\S+): (.+?) \((\d+) MiB, (\d+) MiB free\)\s*$/gm)) {
    const [, id, name, total, free] = match;
    if (id && name) devices.push({ id, name, totalMib: Number(total), freeMib: Number(free) });
  }
  return devices;
}

export function isDedicated(device: GpuDevice): boolean {
  return !INTEGRATED.test(device.name);
}

/**
 * Every workable choice, best first, so a failed load can simply step down to the next one. The CPU
 * is always last, since it's slow but always available.
 */
export function llmChoices(devices: GpuDevice[]): LlmChoice[] {
  const dedicated = devices.filter(isDedicated).toSorted((a, b) => b.freeMib - a.freeMib);
  const choices: LlmChoice[] = [];
  const best = dedicated[0];
  if (best) {
    if (best.freeMib >= E4B_NEEDS_MIB) choices.push({ model: 'gemma4-e4b-it-qat', device: best.id });
    if (best.freeMib >= E2B_NEEDS_MIB) choices.push({ model: 'gemma4-e2b-it-qat', device: best.id });
  }
  choices.push({ model: 'gemma4-e2b-it-qat', device: 'none' });
  return choices;
}

export * from './downloads.ts';
