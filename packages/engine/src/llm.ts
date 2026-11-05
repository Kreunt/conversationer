export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature: number;
  maxTokens: number;
  signal?: AbortSignal;
}

/** Streams reply text. Implemented over HTTP in production and by a stub in tests. */
export type ChatStream = (messages: ChatMessage[], options: ChatOptions) => AsyncIterable<string>;

/** Client for the OpenAI-compatible API served by both llama-server and Ollama. */
export function openAiCompatibleChat(baseUrl: string, model: string): ChatStream {
  return async function* (messages, { temperature, maxTokens, signal }) {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: true,
        // Reasoning adds seconds of silence before speech and doesn't help small talk.
        reasoning_effort: 'none',
      }),
      signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`LLM request failed with ${response.status}: ${await response.text()}`);
    }

    const decoder = new TextDecoder();
    let pending = '';
    for await (const bytes of response.body) {
      pending += decoder.decode(bytes, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
        const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta?.content;
        if (delta) yield delta as string;
      }
    }
  };
}
