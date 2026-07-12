import { FastifyInstance } from 'fastify';
import { getLibrary, getVideoById } from '../db';
import { scanLibrary } from '../scanner';

export default async function libraryRoutes(fastify: FastifyInstance) {
  fastify.get('/', async (request, reply) => {
    const lib = await getLibrary();
    return lib;
  });

  fastify.get('/:id', async (request: any, reply) => {
    const { id } = request.params;
    const video = await getVideoById(id);
    if (!video) {
      return reply.code(404).send({ error: 'Video not found' });
    }
    return video;
  });

  fastify.post('/rescan', async (request, reply) => {
    scanLibrary().catch(console.error);
    return { status: 'scanning started' };
  });
}
