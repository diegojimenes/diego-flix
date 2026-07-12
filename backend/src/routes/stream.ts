import { FastifyInstance } from 'fastify';
import fs from 'fs';
import { getVideoById } from '../db';
import { startTranscode, pingStream } from '../stream';
import path from 'path';
import fsp from 'fs/promises';

export default async function streamRoutes(fastify: FastifyInstance) {
  fastify.get('/:id', async (request: any, reply) => {
    const { id } = request.params;
    const video = await getVideoById(id);
    if (!video) {
      return reply.code(404).send({ error: 'Video not found' });
    }

    const range = request.headers.range;
    if (!range) {
      const stream = fs.createReadStream(video.path);
      return reply.type('video/mp4').send(stream);
    }

    const stat = await fsp.stat(video.path);
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;

    const chunksize = (end - start) + 1;
    const stream = fs.createReadStream(video.path, { start, end });

    reply.code(206);
    reply.header('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Length', chunksize);
    reply.type('video/mp4');
    
    return stream;
  });

  fastify.get('/:id/master.m3u8', async (request: any, reply) => {
    const { id } = request.params;
    const video = await getVideoById(id);
    if (!video) {
      return reply.code(404).send({ error: 'Video not found' });
    }

    const start = request.query.start ? parseInt(request.query.start, 10) : undefined;
    pingStream(id);
    const streamDir = await startTranscode(video, start);
    const playlistPath = path.join(streamDir, 'master.m3u8');

    let retries = 0;
    while (retries < 60) {
      try {
        await fsp.stat(playlistPath);
        break;
      } catch (e) {
        await new Promise(r => setTimeout(r, 500));
        retries++;
      }
    }

    const m3u8 = await fsp.readFile(playlistPath, 'utf8');
    reply.type('application/vnd.apple.mpegurl');
    return m3u8;
  });

  fastify.get('/:id/ping', async (request: any, reply) => {
    const { id } = request.params;
    pingStream(id);
    return reply.send({ success: true });
  });

  fastify.delete('/:id', async (request: any, reply) => {
    const { id } = request.params;
    const { stopTranscode } = require('../stream');
    stopTranscode(id);
    return reply.send({ success: true });
  });

  fastify.get('/:id/:file', async (request: any, reply) => {
    const { id, file } = request.params;
    pingStream(id);
    const streamDir = path.join(process.cwd(), 'streams', id);
    const filePath = path.join(streamDir, file);

    try {
      await fsp.stat(filePath);
      const stream = fs.createReadStream(filePath);
      if (file.endsWith('.ts')) reply.type('video/MP2T');
      else if (file.endsWith('.m3u8')) reply.type('application/vnd.apple.mpegurl');
      else if (file.endsWith('.m4s') || file.endsWith('.mp4')) reply.type('video/mp4');
      return reply.send(stream);
    } catch (e) {
      return reply.code(404).send({ error: 'Segment not found' });
    }
  });
}
