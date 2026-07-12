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

async function fetchTmdbMetadata(filename: string, apiKey: string, type: 'movie' | 'tv' = 'movie', season?: number, episode?: number): Promise<Partial<VideoMetadata> & { seriesTmdbName?: string }> {
  try {
    let cleanName = filename.replace(/\.(mp4|mkv|avi|mov|webm|m4v)$/i, '');
    let year = '';

    const yearMatch = cleanName.match(/(.+?)[\.\s_-]*(?:\(|\[)?((?:19|20)\d{2})(?:\)|\])?/i);
    if (yearMatch) {
      cleanName = yearMatch[1];
      year = yearMatch[2];
    } else {
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
      const result = data.results[0];
      let meta: Partial<VideoMetadata> & { seriesTmdbName?: string } = {
        name: type === 'movie' ? result.title || cleanName : result.name || cleanName,
        plot: result.overview,
        year: (type === 'movie' ? result.release_date : result.first_air_date) ? (type === 'movie' ? result.release_date : result.first_air_date).substring(0, 4) : year,
        posterUrl: result.poster_path ? `https://image.tmdb.org/t/p/w500${result.poster_path}` : undefined,
        backdropUrl: result.backdrop_path ? `https://image.tmdb.org/t/p/w1280${result.backdrop_path}` : undefined,
        tmdbId: result.id,
      };

      if (type === 'tv') {
        meta.seriesTmdbName = result.name || cleanName;
        // Fetch specific episode metadata if season and episode are provided
        if (season !== undefined && episode !== undefined) {
          const epUrl = `https://api.themoviedb.org/3/tv/${result.id}/season/${season}/episode/${episode}?api_key=${apiKey}&language=pt-BR`;
          const epResponse = await fetch(epUrl);
          if (epResponse.ok) {
            const epData = await epResponse.json();
            meta.name = epData.name || meta.name; // Use episode name as the primary name
            meta.plot = epData.overview || meta.plot; // Use episode plot, fallback to series plot
            meta.episodeName = epData.name;
            if (epData.still_path) {
              meta.backdropUrl = `https://image.tmdb.org/t/p/w1280${epData.still_path}`;
            }
          }
        }
      }

      return meta;
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
              let seasonNumber: number | undefined;
              let episodeNumber: number | undefined;
              
              if (relDir !== '.' && relDir !== '') {
                seriesName = relDir.split(path.sep)[0]; // Folder name is used as the base series name to search
                episodeName = path.basename(file.name, ext);
                
                // Extract season number from the folder name (e.g. "Temporada 5", "Season 02")
                const folderSeasonMatch = seriesName.match(/(?:temporada|season)\s*(\d+)/i);
                if (folderSeasonMatch) {
                  seasonNumber = parseInt(folderSeasonMatch[1], 10);
                  // Clean up the series name for TMDB search
                  seriesName = seriesName.replace(/(?:temporada|season)\s*\d+/i, '').replace(/[\.\-\_]+$/, '').trim();
                }
                
                // Parse season and episode from filename, e.g. "S01E05" or "1x05"
                const seMatch = episodeName.match(/[sS](\d+)[eE](\d+)/) || episodeName.match(/(\d+)x(\d+)/);
                if (seMatch) {
                  seasonNumber = parseInt(seMatch[1], 10);
                  episodeNumber = parseInt(seMatch[2], 10);
                } else if (seasonNumber !== undefined) {
                  // If season was found in the folder, but filename is just "01", "02.mkv", "Episodio 1"
                  const epMatch = episodeName.match(/^(?:ep|episodio|episode)?\s*[-_]*\s*(\d+)/i);
                  if (epMatch) {
                    episodeNumber = parseInt(epMatch[1], 10);
                  }
                }
              }

              let tmdbData: any = {};
              if (config.tmdbApiKey) {
                if (seriesName) {
                  tmdbData = await fetchTmdbMetadata(seriesName, config.tmdbApiKey, 'tv', seasonNumber, episodeNumber);
                } else {
                  tmdbData = await fetchTmdbMetadata(file.name, config.tmdbApiKey, 'movie');
                }
              }

              // Use the TMDB official series name if found, otherwise fallback to the folder name
              const finalSeriesName = tmdbData.seriesTmdbName || seriesName;

              videos.push({
                id,
                name: tmdbData.name || (finalSeriesName ? episodeName : path.basename(file.name, ext)),
                path: fullPath,
                size: stat.size,
                ext,
                seriesName: finalSeriesName,
                episodeName: tmdbData.episodeName || episodeName,
                seasonNumber,
                episodeNumber,
                ...metadata,
                ...tmdbData,
                seriesTmdbName: undefined // don't store the temp field in the db directly
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
