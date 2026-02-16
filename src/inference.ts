/**
 * inference.ts — Local text generation via node-llama-cpp for belief
 * extraction and context synthesis.
 *
 * Uses Phi-4-mini-instruct (3.8B) for structured JSON output. The model
 * is lazily loaded on first use.
 *
 * Two primary functions:
 *   - extractBeliefs(): structured JSON extraction from conversation turns
 *   - synthesizeContext(): natural language context briefing from beliefs + memories
 */

import type {
  Llama,
  LlamaModel,
  LlamaContext,
} from "node-llama-cpp";
import type { BeliefNode, ExtractedBelief } from "./graph.js";
import type { SearchResult } from "./search.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_TEXT_MODEL =
  "hf:unsloth/Phi-4-mini-instruct-GGUF/Phi-4-mini-instruct-Q4_K_M.gguf";

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Prompt templates
// ---------------------------------------------------------------------------

const EXTRACTION_SYSTEM_PROMPT = `You extract developer beliefs from conversations. Output ONLY raw JSON, no markdown, no explanation.

Output a JSON object: { "beliefs": [ ... ] }
Each belief object has these fields:
  - subject (string): usually "developer"
  - predicate (string): one of prefers, avoids, uses, workflow, believes, dislikes, pattern
  - object (string): concise description of the tool/practice/preference, under 100 chars. Do NOT include project names in this field.
  - confidence (number): 0.0 to 1.0
  - strength (string): one of strong, moderate, mild
  - project_scope (string or null): which project this belief applies to. null means it applies globally to all projects.

Rules:
- Explicit statements ("I always want X") → confidence 0.9+, strength "strong"
- Implicit preferences from code → confidence 0.5-0.7, strength "moderate"
- IMPORTANT: project_scope rules:
  - If the developer mentions a SPECIFIC project by name, use that name as project_scope
  - "I prefer pnpm only in the web-app project" → object: "pnpm", project_scope: "web-app"
  - "Use Tailwind in this project" → object: "Tailwind", project_scope: current project name
  - "I always prefer TypeScript" → object: "TypeScript", project_scope: null (global)
  - "Always run tests before committing" → project_scope: null (general workflow)
  - When they say "in this project" without naming it, use the current project name
  - When they say "always" or "in general" or don't mention any project, set null (global)
  - When in doubt, make it project-scoped to the current project
- Return {"beliefs": []} if no meaningful beliefs found`;

function buildExtractionPrompt(
  turnContent: string,
  projectContext: string,
): string {
  return `Extract developer beliefs from this conversation.

Current project name: "${projectContext || "unknown"}"

Conversation:
${turnContent}

Output JSON. For project_scope: use "${projectContext || "unknown"}" for this-project-specific beliefs, use the exact project name if the developer mentions a different project by name, or use null for global beliefs.`;
}

/**
 * Parse the model's response into an array of ExtractedBelief objects.
 * Handles both `{ beliefs: [...] }` wrapper format and bare `[...]` arrays,
 * as well as JSON embedded in markdown code fences.
 */
function parseBeliefResponse(raw: string): ExtractedBelief[] {
  // Strip markdown code fences if present
  let text = raw.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch?.[1]) {
    text = fenceMatch[1].trim();
  }

  // Extract the first JSON structure (object or array)
  const jsonMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (!jsonMatch?.[0]) return [];

  try {
    const parsed = JSON.parse(jsonMatch[0]) as
      | { beliefs: ExtractedBelief[] }
      | ExtractedBelief[];

    if (Array.isArray(parsed)) return parsed;
    if (parsed.beliefs && Array.isArray(parsed.beliefs)) return parsed.beliefs;
    return [];
  } catch {
    return [];
  }
}

const SYNTHESIS_SYSTEM_PROMPT = `You are an assistant engineer's internal context synthesizer. You take structured data (beliefs, memories, project info) and produce a unified, natural-language context document.

The output will be injected as "additional context" into a coding assistant's session. Write in second person ("you prefer...", "in this project you...") addressing the developer's coding assistant.

Structure the output as:

## How I Work
[Workflow instructions from baseline + workflow beliefs. Write as first person ("I delegate...", "I research first...")]

## What I Know About You
[Developer preferences, coding style, conventions from preference beliefs]

## Recent Context
[Relevant past conversation fragments and decisions]

Rules:
- Be concise but informative
- Prioritize high-confidence beliefs
- Merge related beliefs into flowing prose, don't just list them
- If there's little data, keep the sections brief rather than padding
- Never fabricate beliefs — only use what's provided`;

// ---------------------------------------------------------------------------
// Inference provider
// ---------------------------------------------------------------------------

export interface InferenceProvider {
  readonly modelId: string;
  extractBeliefs(
    turnContent: string,
    projectContext: string,
  ): Promise<ExtractedBelief[]>;
  synthesizeContext(
    memories: SearchResult[],
    beliefs: BeliefNode[],
    workflowBeliefs: BeliefNode[],
    workflowBaseline: string,
    projectInfo: { name?: string; cwd?: string },
  ): Promise<string>;
  dispose(): void | Promise<void>;
}

class LocalInferenceProvider implements InferenceProvider {
  readonly modelId: string;
  private llama: Llama | null = null;
  private model: LlamaModel | null = null;
  private context: LlamaContext | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(modelPath?: string) {
    this.modelId = modelPath ?? DEFAULT_TEXT_MODEL;
  }

  private async ensureModel(): Promise<void> {
    if (this.model) return;

    if (this.initPromise) {
      await this.initPromise;
      return;
    }

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
        this.context = await this.model.createContext({
          contextSize: 4096,
        });
      }
    })();

    await this.initPromise;
  }

  async extractBeliefs(
    turnContent: string,
    projectContext: string,
  ): Promise<ExtractedBelief[]> {
    await this.ensureModel();
    if (!this.context || !this.model || !this.llama) return [];

    const { LlamaChatSession } = await import("node-llama-cpp");

    const session = new LlamaChatSession({
      contextSequence: this.context.getSequence(),
      systemPrompt: EXTRACTION_SYSTEM_PROMPT,
    });

    try {
      const prompt = buildExtractionPrompt(turnContent, projectContext);

      const response = await session.prompt(prompt, {
        maxTokens: 2048,
        temperature: 0.3,
      });

      // Parse JSON from response — the model may return an object with
      // { beliefs: [...] } or just a bare array [...]
      const beliefs = parseBeliefResponse(response);

      // Validate and clean up
      return beliefs.filter(
        (b) =>
          b.subject &&
          b.predicate &&
          b.object &&
          typeof b.confidence === "number" &&
          b.confidence >= 0.3 &&
          b.confidence <= 1.0,
      ).map((b) => ({
        subject: b.subject,
        predicate: b.predicate,
        object: b.object.slice(0, 200),
        confidence: Math.round(b.confidence * 100) / 100,
        strength: b.strength ?? (b.confidence >= 0.8 ? "strong" : b.confidence >= 0.5 ? "moderate" : "mild"),
        context: b.context,
        project_scope: b.project_scope,
      }));
    } catch {
      return [];
    } finally {
      session.dispose();
    }
  }

  async synthesizeContext(
    memories: SearchResult[],
    beliefs: BeliefNode[],
    workflowBeliefs: BeliefNode[],
    workflowBaseline: string,
    projectInfo: { name?: string; cwd?: string },
  ): Promise<string> {
    await this.ensureModel();
    if (!this.context || !this.model) return workflowBaseline;

    const { LlamaChatSession } = await import("node-llama-cpp");

    const session = new LlamaChatSession({
      contextSequence: this.context.getSequence(),
      systemPrompt: SYNTHESIS_SYSTEM_PROMPT,
    });

    try {
      // Format beliefs for the prompt
      const beliefLines = beliefs
        .filter((b) => !b.contradicted)
        .slice(0, 20)
        .map((b) => {
          const scope = b.project_scope ? ` [${b.project_scope}]` : " [global]";
          return `- (${b.subject}, ${b.predicate}, "${b.object}")${scope} confidence=${b.confidence}`;
        })
        .join("\n");

      const workflowLines = workflowBeliefs
        .filter((b) => !b.contradicted)
        .slice(0, 15)
        .map((b) => {
          const scope = b.project_scope ? ` [${b.project_scope}]` : " [global]";
          return `- "${b.object}"${scope} confidence=${b.confidence}`;
        })
        .join("\n");

      const memoryLines = memories
        .slice(0, 5)
        .map((m) => `- [${m.path}] ${m.snippet.slice(0, 300)}`)
        .join("\n");

      const prompt = `Synthesize the following data into a unified context document for a coding session.

Project: ${projectInfo.name ?? "unknown"}
Working directory: ${projectInfo.cwd ?? "unknown"}

## Workflow Baseline Template
${workflowBaseline}

## Learned Workflow Beliefs
${workflowLines || "(none yet)"}

## Developer Preference Beliefs
${beliefLines || "(none yet)"}

## Relevant Past Conversations
${memoryLines || "(none yet)"}

Produce the unified context document.`;

      const response = await session.prompt(prompt, {
        maxTokens: 2048,
        temperature: 0.3,
      });

      return response.trim();
    } catch {
      // Fallback: return a simple concatenation
      return buildFallbackContext(
        beliefs,
        workflowBeliefs,
        workflowBaseline,
        projectInfo,
      );
    } finally {
      session.dispose();
    }
  }

  async dispose(): Promise<void> {
    this.context?.dispose();
    this.model?.dispose();
    this.context = null;
    this.model = null;

    if (this.llama) {
      await this.llama.dispose();
      this.llama = null;
    }

    this.initPromise = null;
  }
}

// ---------------------------------------------------------------------------
// Fallback context builder (no LLM required)
// ---------------------------------------------------------------------------

/**
 * Build a context document without the LLM, using simple template concatenation.
 * Used as fallback when the text generation model is unavailable.
 */
export function buildFallbackContext(
  beliefs: BeliefNode[],
  workflowBeliefs: BeliefNode[],
  workflowBaseline: string,
  projectInfo: { name?: string; cwd?: string },
): string {
  const lines: string[] = [];

  // Section 1: Workflow Instructions
  lines.push("## How I Work");
  lines.push("");
  lines.push(workflowBaseline.trim());
  lines.push("");

  if (workflowBeliefs.length > 0) {
    const projectWorkflow = workflowBeliefs.filter((b) => b.project_scope === projectInfo.name);
    const globalWorkflow = workflowBeliefs.filter((b) => !b.project_scope);

    if (projectWorkflow.length > 0) {
      lines.push(`For this project (${projectInfo.name}), I've also learned:`);
      for (const b of projectWorkflow) {
        lines.push(`- ${b.object}`);
      }
      lines.push("");
    }

    if (globalWorkflow.length > 0) {
      lines.push("General workflow learnings:");
      for (const b of globalWorkflow) {
        lines.push(`- ${b.object}`);
      }
      lines.push("");
    }
  }

  // Section 2: Developer Preferences (grouped by scope)
  const prefBeliefs = beliefs.filter(
    (b) => b.predicate === "prefers" || b.predicate === "uses" || b.predicate === "avoids" || b.predicate === "dislikes",
  );

  if (prefBeliefs.length > 0) {
    lines.push("## What I Know About You");
    lines.push("");

    const projectPrefs = prefBeliefs.filter((b) => b.project_scope === projectInfo.name);
    const globalPrefs = prefBeliefs.filter((b) => !b.project_scope);

    if (projectPrefs.length > 0) {
      lines.push(`In this project (${projectInfo.name}):`);
      for (const b of projectPrefs.slice(0, 10)) {
        const verb = b.predicate === "avoids" || b.predicate === "dislikes" ? "avoid" : "prefer";
        lines.push(`- You ${verb}: ${b.object}`);
      }
      lines.push("");
    }

    if (globalPrefs.length > 0) {
      if (projectPrefs.length > 0) {
        lines.push("General preferences (all projects):");
      }
      for (const b of globalPrefs.slice(0, 15)) {
        const verb = b.predicate === "avoids" || b.predicate === "dislikes" ? "avoid" : "prefer";
        lines.push(`- You ${verb}: ${b.object}`);
      }
      lines.push("");
    }
  }

  // Section 3: Lessons & patterns (grouped by scope)
  const otherBeliefs = beliefs.filter(
    (b) => b.predicate === "believes" || b.predicate === "pattern",
  );

  if (otherBeliefs.length > 0) {
    lines.push("## Lessons & Patterns");
    lines.push("");

    const projectLessons = otherBeliefs.filter((b) => b.project_scope === projectInfo.name);
    const globalLessons = otherBeliefs.filter((b) => !b.project_scope);

    if (projectLessons.length > 0) {
      lines.push(`This project (${projectInfo.name}):`);
      for (const b of projectLessons.slice(0, 8)) {
        lines.push(`- ${b.object}`);
      }
      lines.push("");
    }

    if (globalLessons.length > 0) {
      if (projectLessons.length > 0) {
        lines.push("General:");
      }
      for (const b of globalLessons.slice(0, 10)) {
        lines.push(`- ${b.object}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createInferenceProvider(
  modelPath?: string,
): InferenceProvider {
  return new LocalInferenceProvider(modelPath);
}
