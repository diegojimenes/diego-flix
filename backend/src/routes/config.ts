import { FastifyInstance } from 'fastify';
import { getConfig, saveConfig } from '../config';
import { scanLibrary } from '../scanner';

export default async function configRoutes(fastify: FastifyInstance) {
  fastify.get('/', async (request, reply) => {
    return await getConfig();
  });

  fastify.post('/', async (request: any, reply) => {
    const { libraryPath, tmdbApiKey } = request.body;
    await saveConfig({ libraryPath, tmdbApiKey });
    // Trigger a scan in background to re-fetch metadata if TMDB key was added
    scanLibrary().catch(console.error);
    return { success: true };
  });
}
