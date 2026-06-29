import { LoadedSkill } from './loader.js';

export class SkillRegistry {
  private skills = new Map<string, LoadedSkill>();

  register(skill: LoadedSkill): void {
    // workspace > global > bundled
    const existing = this.skills.get(skill.manifest.name);
    if (existing) {
      const priority = { workspace: 3, global: 2, bundled: 1 };
      if (priority[skill.source] >= priority[existing.source]) {
        this.skills.set(skill.manifest.name, skill);
      }
    } else {
      this.skills.set(skill.manifest.name, skill);
    }
  }

  get(name: string): LoadedSkill | undefined {
    return this.skills.get(name);
  }

  list(): LoadedSkill[] {
    return Array.from(this.skills.values());
  }

  getByTag(tag: string): LoadedSkill[] {
    return this.list().filter(s => s.manifest.tags?.includes(tag));
  }

  getPromptExtensions(): string[] {
    return this.list()
      .filter(s => s.promptContent)
      .map(s => s.promptContent as string);
  }

  findByCommand(commandName: string): LoadedSkill | undefined {
    return this.list().find(s => 
      s.manifest.commands?.some(c => c.name === commandName || c.aliases?.includes(commandName))
    );
  }
}
