#!/usr/bin/env node
import { Command } from 'commander';
import { registerOnboardCommand } from './commands/onboard.js';
import { registerGatewayCommand } from './commands/gateway.js';
import { registerStatusCommand } from './commands/status.js';
import { registerHealthCommand } from './commands/health.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerPairingCommand } from './commands/pairing.js';
import { registerAllowlistCommand } from './commands/allowlist.js';
import { registerSkillsCommand } from './commands/skills.js';
import { registerPluginsCommand } from './commands/plugins.js';
import { registerCronCommand } from './commands/cron.js';
import { registerWebhooksCommand } from './commands/webhooks.js';
import { registerSandboxCommand } from './commands/sandbox.js';
import { registerOntologyCommand } from './commands/ontology.js';
import { registerReasoningCommand } from './commands/reasoning.js';
import { registerDevicesCommand } from './commands/devices.js';
import { registerMediaCommand } from './commands/media.js';
import { registerProviderCommand } from './commands/provider.js';
import { registerModelCommand } from './commands/model.js';
import { registerAuthCommand } from './commands/auth.js';
import { registerChannelCommand } from './commands/channel.js';
import { registerResetCommand } from './commands/reset.js';
import { registerDataResetCommand } from './commands/data-reset.js';
import { registerRebuildCommand } from './commands/rebuild.js';
import { registerUninstallCommand } from './commands/uninstall.js';

// Guard against tsx dual-package hazard (module resolved twice as ESM + CJS).
// Symbol.for() returns the same symbol across module boundaries, so the flag
// is shared even when this file is evaluated from two different resolution paths.
const GUARD = Symbol.for('ontofelia-cli-guard');
if (!(globalThis as Record<symbol, boolean>)[GUARD]) {
  (globalThis as Record<symbol, boolean>)[GUARD] = true;

  const program = new Command();
  program
    .name('ontofelia')
    .description('Ontofelia Agent Ecosystem CLI')
    .version('0.0.1');

  registerOnboardCommand(program);
  registerGatewayCommand(program);
  registerStatusCommand(program);
  registerHealthCommand(program);
  registerDoctorCommand(program);
  registerPairingCommand(program);
  registerAllowlistCommand(program);
  registerSkillsCommand(program);
  registerPluginsCommand(program);
  registerCronCommand(program);
  registerWebhooksCommand(program);
  registerSandboxCommand(program);
  registerOntologyCommand(program);
  registerReasoningCommand(program);
  registerDevicesCommand(program);
  registerMediaCommand(program);
  registerProviderCommand(program);
  registerModelCommand(program);
  registerAuthCommand(program);
  registerChannelCommand(program);
  registerResetCommand(program);
  registerDataResetCommand(program);
  registerRebuildCommand(program);
  registerUninstallCommand(program);
  program.parse(process.argv);
}