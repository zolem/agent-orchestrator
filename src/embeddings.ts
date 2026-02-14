/**
 * embeddings.ts — Local embedding via node-llama-cpp with GGUF auto-download.
 *
 * Uses embeddinggemma-300M-Q8_0.gguf (~0.6GB) by default.
 * All vectors are L2-normalized before returning (matching OpenClaw's
 * sanitizeAndNormalizeEmbedding).
 *
 * The model is lazily loaded on first use.
 */

import type { Llama, LlamaModel, LlamaEmbeddingContext } from "node-llama-cpp";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_MODEL =
  "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";

// ---------------------------------------------------------------------------
// L2 normalization
// ---------------------------------------------------------------------------

function normalizeEmbedding(vec: number[]): number[] {
  const sanitized = vec.map((v) => (Number.isFinite(v) ? v : 0));
  const magnitude = Math.sqrt(
    sanitized.reduce((sum, v) => sum + v * v, 0),
  );
  if (magnitude < 1e-10) return sanitized;
  return sanitized.map((v) => v / magnitude);
}

// ---------------------------------------------------------------------------
// Embedding provider
// ---------------------------------------------------------------------------

export interface EmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number | null; // null until first embed
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  dispose(): void;
}

class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly modelId: string;
  private _dimensions: number | null = null;
  private llama: Llama | null = null;
  private model: LlamaModel | null = null;
  private context: LlamaEmbeddingContext | null = null;
  private initPromise: Promise<LlamaEmbeddingContext> | null = null;

  constructor(modelPath?: string) {
    this.modelId = modelPath ?? DEFAULT_MODEL;
  }

  get dimensions(): number | null {
    return this._dimensions;
  }

  private async ensureContext(): Promise<LlamaEmbeddingContext> {
    if (this.context) return this.context;

    // Prevent concurrent initialization
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const {
        getLlama,
        resolveModelFile,
        LlamaLogLevel,
      } = await import("node-llama-cpp");

      if (!this.llama) {
        this.llama = await getLlama({ logLevel: LlamaLogLevel.error });
      }

      if (!this.model) {
        const resolved = await resolveModelFile(this.modelId);
        this.model = await this.llama.loadModel({ modelPath: resolved });
      }

      if (!this.context) {
        this.context = await this.model.createEmbeddingContext();
      }

      return this.context;
    })();

    return this.initPromise;
  }

  async embed(text: string): Promise<number[]> {
    const ctx = await this.ensureContext();
    const result = await ctx.getEmbeddingFor(text);
    const vec = normalizeEmbedding(Array.from(result.vector));
    if (this._dimensions === null) {
      this._dimensions = vec.length;
    }
    return vec;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }

  dispose(): void {
    this.context?.dispose();
    this.model?.dispose();
    this.context = null;
    this.model = null;
    this.llama = null;
    this.initPromise = null;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEmbeddingProvider(
  modelPath?: string,
): EmbeddingProvider {
  return new LocalEmbeddingProvider(modelPath);
}
