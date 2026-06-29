import { z } from 'zod';

export const configSchema = z.object({
  version: z.number().default(1),
  gateway: z.object({
    host: z.string().default('127.0.0.1'),
    port: z.number().default(18780),
    token: z.string().default(''),
    bind: z.enum(['loopback', 'lan', 'tailnet', 'custom']).default('loopback'),
    auth: z.object({ 
      tokenRequired: z.boolean().default(true),
      allowQueryToken: z.boolean().default(false)
    }).default({ tokenRequired: true, allowQueryToken: false }),
  }).default({
    host: '127.0.0.1',
    port: 18780,
    token: '',
    bind: 'loopback',
    auth: { tokenRequired: true, allowQueryToken: false }
  }),
  canvasHost: z.object({
    enabled: z.boolean().default(true),
    port: z.number().default(18793),
    pathPrefix: z.string().default('/__ontofelia__/canvas/'),
  }).default({
    enabled: true,
    port: 18793,
    pathPrefix: '/__ontofelia__/canvas/'
  }),
  agents: z.object({
    defaults: z.object({
      workspace: z.string().default('~/.ontofelia/workspace'),
      model: z.string().default('provider/model'),
      mediaMaxMb: z.number().default(8),
      heartbeat: z.record(z.string(), z.unknown()).default({}),
      sandbox: z.object({
        scope: z.enum(['off', 'agent', 'session']).default('off'),
        workspaceAccess: z.enum(['none', 'ro', 'rw']).default('rw'),
        containerImage: z.string().optional(),
        memoryLimitMb: z.number().default(512),
        cpuQuota: z.number().default(100000),
        network: z.boolean().default(false)
      }).default({ scope: 'off', workspaceAccess: 'rw', memoryLimitMb: 512, cpuQuota: 100000, network: false })
    }).default({
      workspace: '~/.ontofelia/workspace',
      model: 'provider/model',
      mediaMaxMb: 8,
      heartbeat: {},
      sandbox: { scope: 'off', workspaceAccess: 'rw', memoryLimitMb: 512, cpuQuota: 100000, network: false }
    }),
    list: z.array(z.unknown()).default([])
  }).default({
    defaults: {
      workspace: '~/.ontofelia/workspace',
      model: 'provider/model',
      mediaMaxMb: 8,
      heartbeat: {},
      sandbox: { scope: 'off', workspaceAccess: 'rw', memoryLimitMb: 512, cpuQuota: 100000, network: false }
    },
    list: []
  }),
  routing: z.object({
    agents: z.record(z.string(), z.unknown()).default({})
  }).default({ agents: {} }),
  channels: z.object({
    telegram: z.object({
      enabled: z.boolean().default(false),
      token: z.string().optional(),
      allowedChats: z.array(z.string()).default([]),
      ownerChatId: z.string().optional(),
    }).optional(),
    discord: z.object({
      enabled: z.boolean().default(false),
      token: z.string().optional(),
      guildId: z.string().optional(),
    }).optional(),
    matrix: z.object({
      enabled: z.boolean().default(false),
      homeserverUrl: z.string().optional(),
      accessToken: z.string().optional(),
    }).optional(),
  }).default({}),
  messages: z.object({
    maxContext: z.number().default(20),
    truncateAt: z.number().default(4000)
  }).default({ maxContext: 20, truncateAt: 4000 }),
  session: z.object({
    maxHistory: z.number().default(50),
    pruneAfterDays: z.number().default(90),
    scope: z.enum(['main', 'per-channel-peer']).default('per-channel-peer'),
  }).default({ maxHistory: 50, pruneAfterDays: 90, scope: 'per-channel-peer' }),
  commands: z.object({
    prefix: z.string().default('/'),
    allowAdminOnly: z.boolean().default(false)
  }).default({ prefix: '/', allowAdminOnly: false }),
  tools: z.object({
    allow: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([])
  }).default({ allow: [], deny: [] }),
  plugins: z.object({
    trusted: z.array(z.string()).default([]),
    allowUntrusted: z.boolean().default(false)
  }).default({ trusted: [], allowUntrusted: false }),
  security: z.object({
    requireGuardian: z.boolean().default(true),
    guardianTimeoutMs: z.number().default(60000)
  }).default({ requireGuardian: true, guardianTimeoutMs: 60000 }),
  memory: z.object({
    backend: z.enum(['fuseki', 'oxigraph', 'memory']).default('oxigraph'),
    triplestore: z.object({
      type: z.enum(['sidecar', 'remote', 'embedded']).default('embedded'),
      dataDir: z.string().default('~/.ontofelia/triplestore'),
      port: z.number().default(18787),
      endpoint: z.string().default('http://127.0.0.1:18787/ontofelia')
    }).default({
      type: 'embedded',
      dataDir: '~/.ontofelia/triplestore',
      port: 18787,
      endpoint: 'http://127.0.0.1:18787/ontofelia'
    }),
    reasoner: z.object({
      enabled: z.boolean().default(true),
      profile: z.enum(['RDFS', 'OWL_DL', 'OWL_FULL']).default('OWL_DL'),
      mode: z.enum(['on-write', 'periodic', 'manual']).default('on-write'),
      periodicIntervalMinutes: z.number().default(60)
    }).default({
      enabled: true,
      profile: 'OWL_DL',
      mode: 'on-write',
      periodicIntervalMinutes: 60
    }),
    ontology: z.object({
      autoEvolve: z.boolean().default(true),
      requireApproval: z.boolean().default(false),
      maxVersions: z.number().default(50)
    }).default({
      autoEvolve: true,
      requireApproval: false,
      maxVersions: 50
    }),
    reflection: z.object({
      enabled: z.boolean().default(true),
      cron: z.string().default('0 3 * * *'),
      targetChannel: z.string().nullable().default(null)
    }).default({
      enabled: true,
      cron: '0 3 * * *',
      targetChannel: null
    }),
    provenance: z.object({
      enabled: z.boolean().default(true),
      trackConfidence: z.boolean().default(true),
      trackSource: z.boolean().default(true)
    }).default({
      enabled: true,
      trackConfidence: true,
      trackSource: true
    }),
    sparqlExposed: z.boolean().default(false)
  }).default({
    backend: 'oxigraph',
    triplestore: {
      type: 'embedded',
      dataDir: '~/.ontofelia/triplestore',
      port: 18787,
      endpoint: 'http://127.0.0.1:18787/ontofelia'
    },
    reasoner: {
      enabled: true,
      profile: 'OWL_DL',
      mode: 'on-write',
      periodicIntervalMinutes: 60
    },
    ontology: {
      autoEvolve: true,
      requireApproval: false,
      maxVersions: 50
    },
    reflection: {
      enabled: true,
      cron: '0 3 * * *',
      targetChannel: null
    },
    provenance: {
      enabled: true,
      trackConfidence: true,
      trackSource: true
    },
    sparqlExposed: false
  }),
  provider: z.object({
    name: z.string().default('mock'),
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
    defaultModel: z.string().default('mock'),
    aliases: z.record(z.string(), z.string()).default({}),
    maxTokens: z.number().optional(),
    temperature: z.number().optional(),
    timeout: z.number().optional(),
    autoFallback: z.boolean().optional(),
    fallbackModels: z.array(z.string()).optional()
  }).default({
    name: 'mock',
    defaultModel: 'mock',
    aliases: {},
    autoFallback: true,
    fallbackModels: []
  })
});

export type OntofeliaConfig = z.infer<typeof configSchema>;
export type ValidationError = z.ZodIssue;
