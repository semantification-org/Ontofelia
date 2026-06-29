import { FastifyInstance } from 'fastify';
import type { GatewayContext } from '../context.js';
import { createLogger, MessageEnvelope, PRIMARY_AGENT_ID } from '@ontofelia/core';
import { safeCompareSecret } from '@ontofelia/security';

function resolveAgentId(agentId?: string): string {
  return !agentId || agentId === 'default' ? PRIMARY_AGENT_ID : agentId;
}

export default async function wsChatRoutes(fastify: FastifyInstance, ctx: GatewayContext) {
  const { config, agents, nodeRegistry, mediaStore, signedUrlService, mimeDetector } = ctx;
  const logger = createLogger('ws-chat');

  // --- Node WebSocket ---
  fastify.get('/ws/node', { websocket: true }, (socket, _req) => {
    let nodeId: string | null = null;

    socket.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        switch (msg.type) {
          case 'pair_request': {
            const result = await nodeRegistry.createPairingRequest({ name: msg.name, surfaces: msg.surfaces });
            socket.send(JSON.stringify({ type: 'pair_response', code: result.code, status: 'pending' }));

            const interval = setInterval(() => {
              const pairedNode = nodeRegistry.get(result.nodeId);
              if (pairedNode && pairedNode.status === 'paired') {
                nodeId = pairedNode.id;
                nodeRegistry.registerConnection(nodeId, socket);
                socket.send(JSON.stringify({ type: 'pair_approved', nodeId }));
                clearInterval(interval);
              } else if (!nodeRegistry.get(result.nodeId) && !(nodeRegistry as unknown as { pendingPairings: Map<string, unknown> }).pendingPairings.has(result.code)) {
                socket.send(JSON.stringify({ type: 'pair_rejected' }));
                socket.close();
                clearInterval(interval);
              }
            }, 2000);

            socket.on('close', () => clearInterval(interval));
            break;
          }
          case 'chat_message': {
            if (!nodeId) {
              socket.send(JSON.stringify({ type: 'error', message: 'Not paired' }));
              break;
            }
            const agent = agents.get(PRIMARY_AGENT_ID);
            if (!agent) break;

            const envelope: MessageEnvelope = {
              id: crypto.randomUUID(),
              channel: 'cli', accountId: 'none', chatType: 'dm',
              sender: { id: `node:${nodeId}`, channelPrefix: 'node', isOwner: false },
              timestamp: new Date().toISOString(), text: msg.text,
              mentions: [], attachments: [],
              routingHints: { sessionId: msg.sessionId }
            };

            const response = await agent.handleMessage(envelope);
            socket.send(JSON.stringify({ type: 'chat_response', text: response.text, sessionId: response.sessionId || envelope.routingHints?.sessionId || 'unknown' }));
            break;
          }
          case 'file_upload': {
            if (!nodeId) {
              socket.send(JSON.stringify({ type: 'error', message: 'Not paired' }));
              break;
            }
            const buffer = Buffer.from(msg.data, 'base64');
            const entry = await mediaStore.store({
              buffer, filename: msg.filename, mimeType: msg.mimeType,
              uploadedBy: `node:${nodeId}`
            });
            if (mimeDetector.isImage(entry.mimeType)) {
              await mediaStore.createThumbnail(entry.id);
            }
            socket.send(JSON.stringify({ type: 'file_response', mediaId: entry.id, url: signedUrlService.createSignedUrl(entry.id) }));
            break;
          }
          case 'health_request':
            socket.send(JSON.stringify({ type: 'health_response', status: 'ok', uptime: process.uptime() }));
            break;
        }
      } catch (e: unknown) {
        socket.send(JSON.stringify({ type: 'error', message: (e as Error).message }));
      }
    });

    socket.on('close', () => {
      if (nodeId) nodeRegistry.removeConnection(nodeId);
    });
  });

  // --- Main Chat WebSocket ---
  fastify.get('/ws', { websocket: true }, (socket, req) => {
    let authenticated = !config.gateway.auth.tokenRequired;

    const url = new URL(req.url, `http://${req.headers.host}`);
    const tokenQuery = url.searchParams.get('token');

    if (config.gateway.auth.allowQueryToken && tokenQuery && safeCompareSecret(tokenQuery, config.gateway.token)) {
      authenticated = true;
      socket.send(JSON.stringify({ type: 'status', data: { status: 'authenticated' } }));
    }

    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        socket.send(JSON.stringify({ type: 'error', code: 'UNAUTHORIZED', message: 'Authentication timeout' }));
        socket.close();
      }
    }, 5000);

    socket.on('message', async (message: unknown) => {
      try {
        const data = JSON.parse(String(message));

        if (!authenticated) {
          if (data.type === 'auth' && safeCompareSecret(data.token, config.gateway.token)) {
            authenticated = true;
            clearTimeout(authTimeout);
            socket.send(JSON.stringify({ type: 'status', data: { status: 'authenticated' } }));
          } else {
            socket.send(JSON.stringify({ type: 'error', code: 'UNAUTHORIZED', message: 'Invalid token' }));
            socket.close();
          }
          return;
        }

        if (data.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong' }));
        } else if (data.type === 'guardian_response') {
          const agentId = resolveAgentId(data.agentId);
          const agent = agents.get(agentId);
          if (agent) {
            agent.resolveGuardianApproval(data.callId, data.approved, data.approveAll);
          }
        } else if (data.type === 'chat') {
          const agentId = resolveAgentId(data.agentId);
          const agent = agents.get(agentId);
          if (!agent) {
            socket.send(JSON.stringify({ type: 'chat_error', code: 'NOT_FOUND', message: `Agent not found: ${agentId}` }));
            return;
          }

          const removeDebug = agent.onDebug((event) => {
            try {
              if (event.phase === 'guardian_confirm') {
                const eventData = event.data as { callId?: string; command?: string };
                socket.send(JSON.stringify({ type: 'guardian_confirm', callId: eventData?.callId, command: eventData?.command }));
              }
              socket.send(JSON.stringify({ type: 'debug_log', ...event }));
            } catch { /* socket may have closed */ }
          });

          // Build attachments
          const wsAttachments: MessageEnvelope['attachments'] = [];
          if (data.attachments && Array.isArray(data.attachments)) {
            for (const att of data.attachments) {
              const attType = att.type?.startsWith('image/') ? 'image' as const
                : att.type?.startsWith('audio/') ? 'audio' as const
                : att.type?.startsWith('video/') ? 'video' as const
                : 'document' as const;
              wsAttachments.push({
                id: crypto.randomUUID(), type: attType,
                url: att.data, mimeType: att.type || 'application/octet-stream',
                filename: att.name,
              });
            }
          }

          const envelope: MessageEnvelope = {
            id: crypto.randomUUID(),
            channel: 'webchat', accountId: 'none', chatType: 'dm',
            sender: { id: 'owner', channelPrefix: 'webchat', isOwner: true },
            timestamp: new Date().toISOString(), text: data.message,
            mentions: [], attachments: wsAttachments,
            routingHints: { sessionId: data.sessionId }
          };

          try {
            for await (const chunk of agent.handleMessageStream(envelope)) {
              socket.send(JSON.stringify(chunk));
            }
            removeDebug();
          } catch (llmError: unknown) {
            removeDebug();
            const errorMsg = (llmError as Error).message || 'LLM request failed';
            logger.error(`LLM error: ${errorMsg}`);

            socket.send(JSON.stringify({
              type: 'chat_error',
              message: `❌ LLM error: ${errorMsg}`,
              originalProvider: config.provider?.name || 'unknown'
            }));

            // Auto-Fallback
            if (config.provider?.autoFallback !== false) {
              const FREE_FALLBACK_MODELS = [
                'deepseek/deepseek-chat-v3-0324:free',
                'meta-llama/llama-3.1-70b-instruct:free',
                'mistralai/mistral-small-3.1-24b-instruct:free',
                'google/gemma-3-27b-it:free',
              ];

              for (const fallbackModel of FREE_FALLBACK_MODELS) {
                try {
                  socket.send(JSON.stringify({
                    type: 'debug_log', timestamp: new Date().toISOString(),
                    phase: 'llm_call', label: `Fallback: trying ${fallbackModel}...`
                  }));

                  const { OpenRouterProvider } = await import('@ontofelia/providers');
                  const fallbackProvider = new OpenRouterProvider();
                  await fallbackProvider.initialize({
                    name: 'openrouter',
                    apiKey: config.provider?.apiKey || process.env.OPENROUTER_API_KEY || '',
                    defaultModel: fallbackModel,
                    baseUrl: 'https://openrouter.ai/api/v1',
                    aliases: {},
                  });

                  const fallbackResponse = await fallbackProvider.chat({
                    model: fallbackModel,
                    messages: [
                      {
                        role: 'system',
                        content: 'You are Ontofelia, a helpful AI assistant. The user determines the conversation language. Reply in the same language as the user\'s latest message, and translate or adapt any templates before replying.'
                      },
                      { role: 'user', content: data.message }
                    ]
                  });

                  socket.send(JSON.stringify({
                    type: 'chat_response', text: fallbackResponse.content,
                    sessionId: 'fallback', fallbackModel, usage: fallbackResponse.usage
                  }));

                  socket.send(JSON.stringify({
                    type: 'debug_log', timestamp: new Date().toISOString(),
                    phase: 'final', label: `Fallback succeeded: ${fallbackModel}`
                  }));

                  return;
                } catch {
                  continue;
                }
              }

              socket.send(JSON.stringify({
                type: 'chat_error',
                message: '❌ All fallback models failed. Please check the provider configuration.'
              }));
            }
          }
        }
      } catch (e: unknown) {
        socket.send(JSON.stringify({ type: 'error', code: 'ERROR', message: (e as Error).message || 'Invalid Request' }));
      }
    });
  });
}
