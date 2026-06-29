import * as fs from 'fs/promises';
import * as path from 'path';
import { SkillManifest } from '@ontofelia/core';

export interface LoadedSkill {
  manifest: SkillManifest;
  basePath: string;        // Path to the skill directory
  promptContent?: string;  // Content of the prompt file (e.g. SKILL.md)
  source: 'workspace' | 'global' | 'bundled';
}

export class SkillLoader {
  async loadFromDirectory(dir: string, source: LoadedSkill['source']): Promise<LoadedSkill[]> {
    const loaded: LoadedSkill[] = [];
    
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillPath = path.join(dir, entry.name);
          const manifestPath = path.join(skillPath, 'skill.json');
          
          try {
            const manifestContent = await fs.readFile(manifestPath, 'utf-8');
            const manifest = this.validateManifest(JSON.parse(manifestContent));
            
            let promptContent: string | undefined;
            try {
              promptContent = await fs.readFile(path.join(skillPath, 'SKILL.md'), 'utf-8');
            } catch {
              // SKILL.md is optional
            }

            loaded.push({
              manifest,
              basePath: skillPath,
              promptContent,
              source
            });
          } catch {
            // Ignore if skill.json doesn't exist or is invalid
            // Could log error here
          }
        }
      }
    } catch {
      // Ignore if directory doesn't exist
    }

    return loaded;
  }

  async loadAll(workspacePath: string, globalPath: string, bundledPath: string): Promise<LoadedSkill[]> {
    const allSkills: LoadedSkill[] = [];
    
    // Load in reverse priority order so later ones overwrite earlier ones in Registry
    // Registry should probably handle the overwriting logic based on priority,
    // but we just return them all.
    const bundled = await this.loadFromDirectory(bundledPath, 'bundled');
    const globalSkills = await this.loadFromDirectory(globalPath, 'global');
    const workspaceSkills = await this.loadFromDirectory(workspacePath, 'workspace');

    allSkills.push(...bundled, ...globalSkills, ...workspaceSkills);
    return allSkills;
  }

  validateManifest(manifest: unknown): SkillManifest {
    // Basic validation
    const m = manifest as SkillManifest;
    if (!m.name || typeof m.name !== 'string') {
      throw new Error('Invalid manifest: missing or invalid name');
    }
    if (!m.version || typeof m.version !== 'string') {
      throw new Error('Invalid manifest: missing or invalid version');
    }
    if (!m.description || typeof m.description !== 'string') {
      throw new Error('Invalid manifest: missing or invalid description');
    }
    return m;
  }
}
