import { FastifyInstance, FastifyRequest } from 'fastify';
import type { GatewayContext } from '../context.js';

export default async function mediaRoutes(fastify: FastifyInstance, ctx: GatewayContext) {
  const { mediaStore, signedUrlService, mimeDetector } = ctx;

  fastify.get('/api/media', async (request: FastifyRequest<{ Querystring: { agentId?: string; sessionId?: string; mimeType?: string } }>) => {
    return mediaStore.list(request.query);
  });

  fastify.post('/api/media/upload', async (request, reply) => {
    const data = await request.file();
    if (!data) return reply.code(400).send({ error: 'No file uploaded' });

    const buffer = await data.toBuffer();
    const mimeType = mimeDetector.detect(buffer, data.filename);

    const entry = await mediaStore.store({
      buffer, filename: data.filename, mimeType,
      uploadedBy: (request.headers['x-uploaded-by'] as string) || 'api'
    });

    if (mimeDetector.isImage(entry.mimeType)) {
      await mediaStore.createThumbnail(entry.id);
    }

    return { id: entry.id, url: signedUrlService.createSignedUrl(entry.id) };
  });

  fastify.delete('/api/media/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const deleted = await mediaStore.delete(request.params.id);
    if (!deleted) return reply.code(404).send({ error: 'Not found' });
    return { success: true };
  });
}