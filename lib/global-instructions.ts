import { promises as fs } from 'fs';
import path from 'path';
import type { AppConfig } from './types';
import { projectRoot } from './data-paths';

const AGENTS_MD_PATH = path.join(projectRoot(), 'AGENTS.md');
const AGENTS_MD_ALT = path.join(projectRoot(), 'agents.md');
const CLAUDE_MD_PATH = path.join(projectRoot(), 'CLAUDE.md');

export async function readAgentsMd(): Promise<string | null> {
  for (const filePath of [AGENTS_MD_PATH, AGENTS_MD_ALT, CLAUDE_MD_PATH]) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      if (content.trim()) return content.trim();
    } catch {
      /* try next */
    }
  }
  return null;
}

export async function buildGlobalInstructionsContext(cfg: AppConfig): Promise<string> {
  const parts: string[] = [];
  const useAgentsMd = cfg.useAgentsMd !== false;
  if (useAgentsMd) {
    const agentsMd = await readAgentsMd();
    if (agentsMd) {
      parts.push(`Repository instructions (AGENTS.md):\n${agentsMd}`);
    }
  }
  if (cfg.globalInstructions?.trim()) {
    parts.push(`Global user instructions:\n${cfg.globalInstructions.trim()}`);
  }
  return parts.join('\n\n');
}