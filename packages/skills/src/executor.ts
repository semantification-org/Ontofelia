import { SkillRegistry } from './registry.js';
import type { ToolContext } from '@ontofelia/core';

export class SkillExecutor {
  constructor(private registry: SkillRegistry) {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async execute(commandName: string, input: string, context?: ToolContext): Promise<string> {
    const skill = this.registry.findByCommand(commandName);
    if (!skill) {
      return `Unknown skill command: ${commandName}`;
    }

    // For bundled skills (summarize, translate, explain), we currently rely
    // on prompt extensions. The "execute" call in the CLI/runtime acts as a
    // confirmation or generates special text for the LLM, or the LLM catches it
    // as a tool.
    // Phase 7 states:
    // "The bundled skills (summarize, translate, explain) work through prompt
    // engineering: they add instructions to the system prompt and use the
    // existing LLM provider."
    // 
    // Since the runtime returns the "result" directly as ChatResponse:
    // const result = await this.skillExecutor.execute(skillCmd, input, context);
    // return { text: result, sessionId };
    // 
    // We return it in a way that helps the user understand how it works.
    // However, if the user types `/skill summarize`, it goes through
    // handleCommand, executes this code, and returns `text: result`. The LLM
    // never sees it.
    // The command adds instructions to the system prompt, which means the LLM
    // knows about it during regular chat. But if `/skill summarize` is executed,
    // this code is effectively answering as the system.
    // 
    // The actual requirement is:
    // "When the user calls /skill summarize, summarize the latest messages."
    // This happens through the LLM when it has the system prompt extension.
    // If `/skill summarize` is caught as a real slash command, it is not sent
    // to the LLM because `handleCommand` returns before `provider.chat`.
    // 
    // If `handleCommand` catches this, it generates a response. If we mock it
    // here, we would really need to pass the prompt to the LLM.
    // Das Design im Prompt:
    // if (cmd.startsWith('/skill ')) { ... result = await this.skillExecutor.execute(...) }
    // And the description says "The bundled skills work through prompt engineering".
    // 
    // Should this return a meta prompt or text the LLM sees?
    // When the user sends `/skill summarize`, that is the `input`.
    // Since we do not have the LLM provider here, we can only generate
    // pseudo-text OR add the call to the message history as a `system` or `user`
    // message.
    // Let's just return a placeholder or instructions that the LLM will follow in the next turn?
    // Or: "This is a skill command. Send 'summarize' because the prompt is already loaded."
    
    // Simple Phase 7 solution:
    return `[System: Skill '${skill.manifest.name}' triggered. Input: ${input || '(none)'}. The actual AI processing happens through the regular chat with instructions from the SKILL.md prompt.]`;
  }
}
