declare module 'node-llama-cpp' {
  export const LlamaLogLevel: Record<string, unknown>;
  export function getLlama(options?: Record<string, unknown>): Promise<any>;
  export class LlamaChatSession {
    constructor(options: Record<string, unknown>);
    prompt(text: string, options?: Record<string, unknown>): Promise<string>;
    setChatHistory(history: unknown[]): Promise<void>;
    dispose(): Promise<void>;
  }
}
