import Fastify, { FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { OntofeliaConfig } from '@ontofelia/config';
import { createLogger, AgentConfig, ChannelType, ChannelBinding, MessageEnvelope, PRIMARY_AGENT_ID } from '@ontofelia/core';
import { SessionStore } from '@ontofelia/session-store';
import { AgentRuntime } from '@ontofelia/agent-runtime';
import { MockProvider } from '@ontofelia/testkit';
import { ProviderFactory } from '@ontofelia/providers';
import { safeCompareSecret } from '@ontofelia/security';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';

import { initTriplestore } from './services/triplestore.js';
import { initToolRegistry } from './services/tools.js';
import { initChannels } from './services/channels.js';
import { initPluginsAndSkills } from './services/plugins.js';
import type { GatewayContext } from './context.js';

const GATEWAY_GUARD = Symbol.for('ontofelia-gateway-started');

export async function startGateway(config: OntofeliaConfig): Promise<FastifyInstance> {
  // Guard against dual-package hazard (tsx may resolve this module twice)
  if ((globalThis as Record<symbol, boolean>)[GATEWAY_GUARD]) {
    return null as unknown as FastifyInstance;
  }
  (globalThis as Record<symbol, boolean>)[GATEWAY_GUARD] = true;

  const logger = createLogger('gateway');

  if (!config.gateway.token || config.gateway.token.trim() === '') {
    throw new Error('Gateway token is required. Run ontofelia onboard to generate one.');
  }

  // --- Provider ---
  let provider: import('@ontofelia/core').ProviderAdapter;
  if (config.provider && config.provider.name !== 'mock') {
    const providerInstance = ProviderFactory.create(config.provider.name);
    if ((config.provider.name === 'openai' || config.provider.name === 'openai-codex') && !config.provider.apiKey) {
      const storedToken = await (providerInstance as unknown as { loadStoredToken: () => Promise<string | null> }).loadStoredToken();
      if (storedToken) {
        (config.provider as import('@ontofelia/core').ProviderConfig).oauthToken = storedToken;
        logger.info(`Using stored OAuth token for ${config.provider.name}`);
      }
    }
    await providerInstance.initialize(config.provider as import('@ontofelia/core').ProviderConfig);
    provider = providerInstance;
    logger.info(`Provider: ${config.provider.name} (${config.provider.defaultModel})`);
  } else {
    provider = new MockProvider();
    logger.warn('No provider configured — using MockProvider');
  }

  // --- Media & Nodes ---
  const { MediaStore, SignedUrlService, MimeDetector } = await import('@ontofelia/media');
  const { NodeRegistry } = await import('@ontofelia/nodes');
  const mediaDir = path.join(os.homedir(), '.ontofelia', 'media');
  const mediaStore = new MediaStore(mediaDir, path.join(mediaDir, 'db.json'));
  await mediaStore.initialize();
  const signedUrlService = new SignedUrlService(config.gateway.token || 'secret');
  const mimeDetector = new MimeDetector();
  const nodeRegistry = new NodeRegistry(path.join(os.homedir(), '.ontofelia', 'nodes.json'));
  await nodeRegistry.load();

  // --- Sessions ---
  const agentsPath = path.join(config.agents.defaults.workspace.replace(/^~/, os.homedir()), '..', 'agents', PRIMARY_AGENT_ID, 'sessions');
  const sessionStore = new SessionStore(agentsPath);

  // --- Triplestore & Knowledge ---
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const { triplestore, fusekiManager, fusekiWatchdog, knowledgeEngine, ontologyManager, conflictDetector, reflectionRunner, ontologyBasePath } =
    await initTriplestore(config, currentDir, logger);

  // --- Sandbox ---
  const { DockerSandboxAdapter, NoopSandboxAdapter } = await import('@ontofelia/sandbox');
  const defaultSandboxConfig: AgentConfig['sandbox'] = {
    scope: config.agents.defaults.sandbox.scope,
    workspaceAccess: config.agents.defaults.sandbox.workspaceAccess
  };
  const sandboxAdapter = defaultSandboxConfig.scope !== 'off'
    ? new DockerSandboxAdapter()
    : new NoopSandboxAdapter();

  // --- Tools & Policy ---
  const { toolRegistry, toolPolicy, auditLog } =
    await initToolRegistry(config, knowledgeEngine, triplestore, sandboxAdapter, ontologyManager, defaultSandboxConfig, logger);

  // Auto-populate urn:<agent>:skills from the live tool registry. Per concept
  // §2 this graph is auto-generated documentation of what the agent can do —
  // not a place anyone writes to manually. Rebuilt on every boot so removed
  // tools do not linger.
  try {
    const tools = toolRegistry.list().map(t => ({
      name: t.name,
      description: t.description,
      category: (t as { category?: string }).category,
    }));
    const written = await knowledgeEngine.seedSkillsGraph(PRIMARY_AGENT_ID, tools);
    logger.info(`Skills graph seeded with ${written} tool descriptors`);
  } catch (e) {
    logger.warn('Could not seed skills graph: ' + (e as Error).message);
  }

  // Auto-populate urn:<agent>:setup with the runtime environment so the
  // setup graph reflects the live configuration (concept §2).
  try {
    await knowledgeEngine.seedSetupGraph(PRIMARY_AGENT_ID, {
      triplestoreBackend: config.memory.backend,
      reasonerBackend: 'reasonable',
      reasonerProfile: config.memory.reasoner?.profile,
      sandboxScope: config.agents.defaults.sandbox.scope,
      workspace: config.agents.defaults.workspace,
      gatewayHost: config.gateway.host,
      gatewayPort: config.gateway.port,
    });
    logger.info('Setup graph seeded');
  } catch (e) {
    logger.warn('Could not seed setup graph: ' + (e as Error).message);
  }

  // Block NoopSandbox in production if dangerous tools are allowed
  const isProduction = process.env.NODE_ENV === 'production';
  const toolPolicyConfig = (config.tools as { allow?: string[] }) || { allow: [] };
  const hasDangerousTools = toolPolicyConfig.allow?.some((t: string) => ['exec', 'cron_manage', 'fs_write'].includes(t));
  if (isProduction && defaultSandboxConfig.scope === 'off' && hasDangerousTools) {
    logger.fatal('CRITICAL: NoopSandbox not allowed in production with dangerous tools enabled.');
    process.exit(1);
  }

  // --- Skills & Plugins ---
  const { skillRegistry, skillExecutor, pluginLoader, pluginRegistry, skillLoader } =
    await initPluginsAndSkills(config, currentDir, logger);

  // --- Agent ---
  const defaultAgentConfig: AgentConfig = {
    agentId: PRIMARY_AGENT_ID,
    name: 'Ontofelia',
    model: config.agents.defaults.model,
    workspace: config.agents.defaults.workspace,
    systemPrompt:
      'You are Ontofelia, an autonomous AI whose long-term memory is a governed knowledge graph. ' +
      'Use the memory_* tools for ALL memory operations — never exec/curl/shell to read or write memory. ' +
      'To remember: memory_store. To recall: memory_query / memory_ask / memory_sparql. ' +
      'To explain a belief: memory_explain. ' +
      'When the user asks you to FORGET or DELETE a fact, you MUST call memory_retract with that ' +
      "fact's subject and predicate to hard-delete it from the graph — do not merely acknowledge it.",
    memoryPolicy: { autoFlushBeforeCompaction: true, defaultConfidence: 'high', trustUntrustedContent: false },
    sessionPolicy: { scope: 'per-channel-peer' },
    enabledTools: [],
    enabledSkills: [],
    channelBindings: {} as Record<ChannelType, ChannelBinding>,
    sandbox: defaultSandboxConfig,
    mediaMaxMb: config.agents.defaults.mediaMaxMb,
    owner: 'system'
  };

  const defaultAgent = new AgentRuntime(PRIMARY_AGENT_ID, defaultAgentConfig, provider, sessionStore, toolRegistry, toolPolicy, auditLog, skillRegistry, skillExecutor, pluginRegistry, config.provider as import('@ontofelia/core').ProviderConfig, knowledgeEngine);
  await defaultAgent.initialize();

  const agents = new Map<string, AgentRuntime>();
  agents.set(PRIMARY_AGENT_ID, defaultAgent);

  // --- Channels ---
  const { channelRegistry, pairingStore, allowlistStore } =
    await initChannels(config, agents);

  // --- Scheduler ---
  const { JobScheduler, WebhookRegistry } = await import('@ontofelia/scheduler');
  const schedulerPath = path.join(os.homedir(), '.ontofelia', 'scheduler');
  const scheduler = new JobScheduler(schedulerPath);
  await scheduler.load();

  scheduler.onJob(async (job) => {
    const agent = agents.get(job.agentId || PRIMARY_AGENT_ID);
    if (!agent) return;
    const envelope: MessageEnvelope = {
      id: crypto.randomUUID(),
      channel: 'cron',
      accountId: 'system',
      chatType: 'cron',
      sender: { id: 'scheduler', channelPrefix: 'cron', isOwner: true },
      timestamp: new Date().toISOString(),
      text: job.prompt,
      mentions: [],
      attachments: [],
      routingHints: { forceNewSession: true }
    };
    try {
      await agent.handleMessage(envelope);
    } catch (e) {
      logger.error(`Cron job error for agent ${agent.agentId}: ${e}`);
    }
  });
  scheduler.start();

  // --- Cognitive-architecture background jobs (Phase H) ---
  // Each job drives an idempotent `/cog` maintenance command. They are
  // registered once (idempotent by name) and run on a cron cadence, but the
  // underlying work is itself gated by per-agent cognitive flags (retention /
  // procedural / metacognition), so a fresh install fires no-ops until an
  // operator opts in. Individually disableable/removable via the cron API.
  const cogJobDefaults = [
    { name: 'cog.retention', cron: '0 3 * * *', prompt: '/cog retain' },
    { name: 'cog.consolidation', cron: '0 */6 * * *', prompt: '/cog consolidate' },
    { name: 'cog.metacog-scan', cron: '0 4 * * 0', prompt: '/cog scan' },
  ];
  const existingCogNames = new Set(scheduler.listCronJobs().map((j) => j.name));
  for (const def of cogJobDefaults) {
    if (existingCogNames.has(def.name)) continue;
    try {
      await scheduler.addCronJob({
        name: def.name,
        cron: def.cron,
        agentId: PRIMARY_AGENT_ID,
        prompt: def.prompt,
        enabled: true,
      });
      logger.info(`Registered cognitive background job: ${def.name} (${def.cron})`);
    } catch (e) {
      logger.error(`Failed to register cognitive job ${def.name}: ${(e as Error).message}`);
    }
  }

  const webhookRegistry = new WebhookRegistry(schedulerPath);
  await webhookRegistry.load();

  // --- Fastify Server ---
  const fastify = Fastify({
    logger: { level: 'info', redact: ['gateway.token', 'agents[*].apiKey'] }
  });

  await fastify.register(fastifyWebsocket);
  await fastify.register(fastifyMultipart);

  // Global Auth Hook
  fastify.addHook('onRequest', async (request, reply) => {
    if (request.url === '/api/health') return;
    if (request.url === '/ws' || request.url === '/ws/node') return;
    if (request.url.startsWith('/canvas/media/')) return;
    if (request.url.startsWith('/webhooks/')) return;
    if (!request.url.startsWith('/api/')) return;

    if (config.gateway.auth.tokenRequired) {
      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ') || !safeCompareSecret(authHeader.split(' ')[1], config.gateway.token)) {
        reply.code(401).send({ error: 'Unauthorized' });
        return;
      }
    }
  });

  // Static UI files
  const webUiDist = path.resolve(currentDir, '..', '..', 'web-ui', 'dist');
  if (fs.existsSync(webUiDist)) {
    await fastify.register(fastifyStatic, { root: webUiDist, prefix: '/' });
    fastify.setNotFoundHandler(async (request, reply) => {
      if (!request.url.startsWith('/api/') && !request.url.startsWith('/ws') && !request.url.startsWith('/webhooks/')) {
        return reply.sendFile('index.html');
      }
      reply.code(404).send({ error: 'Not found' });
    });
  }

  // Cleanup hook
  fastify.addHook('onClose', async () => {
    sessionStore.close();
    scheduler.stop();
    if (fusekiWatchdog) fusekiWatchdog.stop();
    if (fusekiManager) await fusekiManager.stop();
    await channelRegistry.disconnectAll();
  });

  // --- Register Route Modules ---
  const ctx: GatewayContext = {
    config, sessionStore, provider, mediaStore, signedUrlService, mimeDetector,
    nodeRegistry, triplestore, fusekiManager, knowledgeEngine, ontologyManager,
    conflictDetector, reflectionRunner, toolRegistry, channelRegistry, pairingStore,
    allowlistStore, skillLoader, skillRegistry, skillExecutor,
    pluginLoader, pluginRegistry, scheduler, webhookRegistry, sandboxAdapter,
    agents, ontologyBasePath
  };

  const { default: authRoutes } = await import('./routes/auth.js');
  const { default: memoryRoutes } = await import('./routes/memory.js');
  const { default: agentRoutes } = await import('./routes/agent.js');
  const { default: systemRoutes } = await import('./routes/system.js');
  const { default: adminRoutes } = await import('./routes/admin.js');
  const { default: mediaRoutes } = await import('./routes/media.js');
  const { default: wsChatRoutes } = await import('./ws/chat.js');
  const { default: wsTerminalRoutes } = await import('./ws/terminal.js');

  await fastify.register(authRoutes, ctx);
  await fastify.register(memoryRoutes, ctx);
  await fastify.register(agentRoutes, ctx);
  await fastify.register(systemRoutes, ctx);
  await fastify.register(adminRoutes, ctx);
  await fastify.register(mediaRoutes, ctx);
  await fastify.register(wsChatRoutes, ctx);
  await fastify.register(wsTerminalRoutes, ctx);

  // --- Listen ---
  const host = config.gateway.bind === 'loopback' ? '127.0.0.1' : '0.0.0.0';

  if (config.gateway.bind !== 'loopback' && (!config.gateway.token || config.gateway.token.trim() === '')) {
    throw new Error('Gateway token is required for non-loopback bindings. Run ontofelia onboard to generate one.');
  }

  try {
    await fastify.listen({ port: config.gateway.port, host });
    logger.info(`Ontofelia Gateway listening on ${host}:${config.gateway.port}`);
  } catch (err) {
    fastify.log.error(err);
    throw err;
  }

  return fastify;
}
