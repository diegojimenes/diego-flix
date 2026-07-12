import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import ffmpeg from 'fluent-ffmpeg';
import ffprobeStatic from 'ffprobe-static';
import { saveLibrary, VideoMetadata } from './db';
import { getConfig } from './config';
import chokidar from 'chokidar';

ffmpeg.setFfprobePath(ffprobeStatic.path);

const ALLOWED_EXTENSIONS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v']);

async function fetchTmdbMetadata(filename: string, apiKey: string, type: 'movie' | 'tv' = 'movie'): Promise<Partial<VideoMetadata>> {
  try {
    let cleanName = filename.replace(/\.(mp4|mkv|avi|mov|webm|m4v)$/i, '');
    let year = '';

    // Extract year and name: "Movie.Name.2023.1080p" -> "Movie Name", "2023"
    const yearMatch = cleanName.match(/(.+?)[\.\s_-]*(?:\(|\[)?((?:19|20)\d{2})(?:\)|\])?/i);
    if (yearMatch) {
      cleanName = yearMatch[1];
      year = yearMatch[2];
    } else {
      // If no year, strip common release tags
      const tagMatch = cleanName.match(/(.+?)[\.\s_-]*(?:1080p|720p|2160p|4k|x264|h264|x265|hevc|bluray|web-dl|HDRip|HDTV)/i);
      if (tagMatch) {
        cleanName = tagMatch[1];
      }
    }

    cleanName = cleanName.replace(/[\.\_-]/g, ' ').trim();
    if (!cleanName) return {};

    const url = new URL(`https://api.themoviedb.org/3/search/${type}`);
    url.searchParams.append('api_key', apiKey);
    url.searchParams.append('query', cleanName);
    url.searchParams.append('language', 'pt-BR');
    if (year) url.searchParams.append('year', year);

    const response = await fetch(url.toString());
    const data = await response.json();

    if (data.results && data.results.length > 0) {
      const movie = data.results[0];
      return {
        name: type === 'movie' ? movie.title || cleanName : movie.name || cleanName,
        plot: movie.overview,
        year: (type === 'movie' ? movie.release_date : movie.first_air_date) ? (type === 'movie' ? movie.release_date : movie.first_air_date).substring(0, 4) : year,
        posterUrl: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : undefined,
        backdropUrl: movie.backdrop_path ? `https://image.tmdb.org/t/p/w1280${movie.backdrop_path}` : undefined,
        tmdbId: movie.id,
      };
    }
  } catch (err) {
    console.error(`Failed to fetch TMDB data for ${filename}:`, err);
  }
  return {};
}

function getProbeData(filePath: string): Promise<ffmpeg.FfprobeData> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

let isScanning = false;

export async function scanLibrary(): Promise<void> {
  if (isScanning) return;
  isScanning = true;

  try {
    const config = await getConfig();
    if (!config.libraryPath) {
      console.log('No library path configured.');
      return;
    }

    const videos: VideoMetadata[] = [];
    
    async function walk(dir: string) {
      try {
        const files = await fs.readdir(dir, { withFileTypes: true });
        for (const file of files) {
          const fullPath = path.join(dir, file.name);
          if (file.isDirectory()) {
            await walk(fullPath);
          } else {
            const ext = path.extname(file.name).toLowerCase();
            if (ALLOWED_EXTENSIONS.has(ext)) {
              const stat = await fs.stat(fullPath);
              const id = crypto.createHash('md5').update(fullPath).digest('hex');
              
              let metadata: Partial<VideoMetadata> = {};
              try {
                const probe = await getProbeData(fullPath);
                const format = probe.format;
                const videoStream = probe.streams.find(s => s.codec_type === 'video');
                const audioStreams = probe.streams.filter(s => s.codec_type === 'audio');
                const ptStream = audioStreams.find(s => {
                  const lang = s.tags?.language?.toLowerCase();
                  return lang === 'por' || lang === 'pt' || lang === 'pt-br';
                });
                const bestAudio = ptStream || audioStreams[0];
                const audioIndex = bestAudio ? audioStreams.indexOf(bestAudio) : 0;
                
                let streamType: 'direct' | 'remux' | 'transcode' = 'transcode';
                const vCodec = videoStream?.codec_name;
                const aCodec = bestAudio?.codec_name;
                const isH264 = vCodec === 'h264';
                const isAacMp3 = aCodec === 'aac' || aCodec === 'mp3';
                
                if (ext === '.mp4' && isH264 && isAacMp3) {
                  streamType = 'direct';
                } else if (ext === '.mkv' && isH264 && isAacMp3) {
                  streamType = 'remux';
                }
                
                metadata = {
                  duration: format.duration,
                  videoCodec: vCodec,
                  audioCodec: aCodec,
                  audioIndex,
                  width: videoStream?.width,
                  height: videoStream?.height,
                  container: format.format_name,
                  streamType,
                  needsTranscode: streamType !== 'direct'
                };
              } catch (e) {
                console.error(`Error probing file ${fullPath}:`, e);
              }

              const relPath = path.relative(config.libraryPath, fullPath);
              const relDir = path.dirname(relPath);
              let seriesName: string | undefined;
              let episodeName: string | undefined;
              
              if (relDir !== '.' && relDir !== '') {
                seriesName = relDir.split(path.sep)[0];
                episodeName = path.basename(file.name, ext);
              }

              let tmdbData = {};
              if (config.tmdbApiKey) {
                if (seriesName) {
                  tmdbData = await fetchTmdbMetadata(seriesName, config.tmdbApiKey, 'tv');
                } else {
                  tmdbData = await fetchTmdbMetadata(file.name, config.tmdbApiKey, 'movie');
                }
              }

              videos.push({
                id,
                name: tmdbData.name || (seriesName ? episodeName : path.basename(file.name, ext)),
                path: fullPath,
                size: stat.size,
                ext,
                seriesName,
                episodeName,
                ...metadata,
                ...tmdbData,
              } as VideoMetadata);
            }
          }
        }
      } catch (e) {
        console.error(`Failed to read directory ${dir}:`, e);
      }
    }

    console.log('Starting scan at', config.libraryPath);
    await walk(config.libraryPath);
    await saveLibrary(videos);
    console.log('Scan complete. Found', videos.length, 'videos.');
  } finally {
    isScanning = false;
  }
}

let watcher: chokidar.FSWatcher | null = null;
let scanTimeout: NodeJS.Timeout | null = null;

export async function startLibraryWatcher() {
  const config = await getConfig();
  if (!config.libraryPath) return;

  if (watcher) {
    await watcher.close();
  }

  console.log(`Starting watcher on ${config.libraryPath}`);
  watcher = chokidar.watch(config.libraryPath, {
    ignored: /(^|[\/\\])\../,
    persistent: true,
    ignoreInitial: true,
  });

  const triggerScan = () => {
    if (scanTimeout) clearTimeout(scanTimeout);
    scanTimeout = setTimeout(() => {
      console.log('File change detected, rescanning library...');
      scanLibrary();
    }, 5000); // debounce 5 seconds
  };

  watcher.on('add', triggerScan);
  watcher.on('unlink', triggerScan);
}
