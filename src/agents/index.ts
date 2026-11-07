import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentSpec } from '../types.ts';
import { claudeAgent } from './claude.ts';
import { museAgent } from './muse.ts';
import { commandAgent } from './command.ts';
import { cursorAgent } from './cursor.ts';

export interface RunRequest {
  prompt: string;
  cwd: string;
  timeoutMs: number;
  maxUsd?: number;
  /** Ask for a structured final answer matching this JSON Schema. */
  jsonSchema?: object;
  /** Raw transcript goes here, for debugging a run after the fact. */
  logFile: string;
}

export interface RunResult {
  ok: boolean;
  /** Final text answer (the worker's summary). */
  output: string;
  structured?: unknown;
  costUsd: number;
  error?: string;
  /** The provider's usage window is exhausted: not the agent's fault, retry after untilMs. */
  rateLimited?: { untilMs: number };
}

/** One coding/research agent CLI. Every provider is reduced to this interface. */
export interface Agent {
  name: string;
  provider: string;
  run(req: RunRequest): Promise<RunResult>;
}

export function makeAgent(name: string, spec: AgentSpec): Agent {
  switch (spec.adapter) {
    case 'claude':
      return claudeAgent(name, spec);
    case 'muse':
      return museAgent(name, spec);
    case 'command':
      return commandAgent(name, spec);
    case 'cursor':
      return cursorAgent(name, spec);
    default:
      throw new Error(`agent ${name}: unknown adapter ${(spec as AgentSpec).adapter}`);
  }
}

export function writeLog(file: string, parts: Record<string, string>) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Object.entries(parts).map(([k, v]) => `===== ${k} =====\n${v}\n`).join('\n'));
}
