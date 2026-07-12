import fs from 'fs/promises';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'library.json');

export interface VideoMetadata {
  id: string;
  name: string;
  path: string;
  size: number;
  ext: string;
  duration?: number;
  videoCodec?: string;
  audioCodec?: string;
  audioIndex?: number;
  width?: number;
  height?: number;
  container?: string;
  needsTranscode?: boolean;
  streamType?: 'direct' | 'remux' | 'transcode';

  // TMDB Metadata
  posterUrl?: string;
  backdropUrl?: string;
  plot?: string;
  year?: string;
  tmdbId?: number;

  // Series Metadata
  seriesName?: string;
  episodeName?: string;
  seasonNumber?: number;
  episodeNumber?: number;
}

export async function getLibrary(): Promise<VideoMetadata[]> {
  try {
    const data = await fs.readFile(DB_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

export async function saveLibrary(library: VideoMetadata[]): Promise<void> {
  await fs.writeFile(DB_PATH, JSON.stringify(library, null, 2), 'utf-8');
}

export async function getVideoById(id: string): Promise<VideoMetadata | null> {
  const lib = await getLibrary();
  return lib.find(v => v.id === id) || null;
}
