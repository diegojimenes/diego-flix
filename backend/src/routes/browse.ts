import { FastifyInstance } from 'fastify';
import fs from 'fs/promises';
import path from 'path';

export default async function browseRoutes(fastify: FastifyInstance) {
  fastify.get('/', async (request: any, reply) => {
    const targetPath = request.query.path || '/';
    
    try {
      const files = await fs.readdir(targetPath, { withFileTypes: true });
      const dirs = files.filter(f => f.isDirectory() && !f.name.startsWith('.')).map(f => f.name);
      
      const parent = path.dirname(targetPath);
      
      return { current: targetPath, dirs, parent: parent !== targetPath ? parent : null };
    } catch (e: any) {
      return reply.code(400).send({ error: 'Invalid path', details: e.message });
    }
  });
}
