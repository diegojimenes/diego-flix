import { FastifyInstance } from 'fastify';
import { getHistory, updateHistory } from '../history';

export default async function historyRoutes(fastify: FastifyInstance) {
  fastify.get('/', async (request, reply) => {
    try {
      const history = await getHistory();
      return history;
    } catch (error: any) {
      reply.status(500).send({ error: error.message });
    }
  });

  fastify.post('/', async (request, reply) => {
    try {
      const { videoId, progress, duration, watched } = request.body as any;
      if (!videoId) return reply.status(400).send({ error: 'videoId is required' });
      await updateHistory(videoId, progress || 0, duration || 0, watched || false);
      return { success: true };
    } catch (error: any) {
      reply.status(500).send({ error: error.message });
    }
  });
}
