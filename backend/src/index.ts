import Fastify from 'fastify';
import cors from '@fastify/cors';
import libraryRoutes from './routes/library';
import streamRoutes from './routes/stream';
import configRoutes from './routes/config';
import browseRoutes from './routes/browse';
import { cleanupStreams } from './stream';
import { scanLibrary, startLibraryWatcher } from './scanner';

import historyRoutes from './routes/history';

const fastify = Fastify({ logger: true });

fastify.register(cors, { origin: '*' });

fastify.register(libraryRoutes, { prefix: '/api/library' });
fastify.register(streamRoutes, { prefix: '/api/stream' });
fastify.register(configRoutes, { prefix: '/api/config' });
fastify.register(browseRoutes, { prefix: '/api/browse' });
fastify.register(historyRoutes, { prefix: '/api/history' });

const start = async () => {
  try {
    await cleanupStreams();
    await fastify.listen({ port: 3001, host: '0.0.0.0' });
    console.log(`Server running at http://0.0.0.0:3001`);
    
    // Initial scan and watch on startup
    scanLibrary().catch(console.error);
    startLibraryWatcher().catch(console.error);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
