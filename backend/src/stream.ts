import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { VideoMetadata } from './db';
import ffmpegStatic from 'ffmpeg-static';

const activeTranscodes = new Map<string, ReturnType<typeof spawn>>();
const lastActivity = new Map<string, number>();

export function pingStream(id: string) {
  lastActivity.set(id, Date.now());
}

export function stopTranscode(id: string) {
  const existing = activeTranscodes.get(id);
  if (existing) {
    console.log(`Stopping transcode for ${id} explicitly.`);
    existing.kill('SIGKILL');
  }
}

export async function startTranscode(video: VideoMetadata, startSeconds?: number): Promise<string> {
  const streamDir = path.join(process.cwd(), 'streams', video.id);
  
  if (activeTranscodes.has(video.id)) {
    if (startSeconds !== undefined) {
      console.log(`Seek requested for ${video.id} to ${startSeconds}s, killing old transcode.`);
      const existing = activeTranscodes.get(video.id);
      if (existing) existing.kill('SIGKILL');
      activeTranscodes.delete(video.id);
      // Let it recreate the folder
    } else {
      pingStream(video.id);
      return streamDir;
    }
  }

  // Clear directory if we are seeking to start fresh
  if (startSeconds !== undefined) {
    try { await fs.rm(streamDir, { recursive: true, force: true }); } catch (e) {}
  }

  try {
    await fs.mkdir(streamDir, { recursive: true });
  } catch (e) {}

  const playlistPath = path.join(streamDir, 'master.m3u8');
  
  if (startSeconds === undefined) {
    try {
      await fs.stat(playlistPath);
      return streamDir; 
    } catch (e) {}
  }
  pingStream(video.id);
  // We'll set it properly after spawning, but mark as starting
  activeTranscodes.set(video.id, null as any);

  let ffmpegArgs: string[] = [];

  const hasAudio = video.audioCodec !== undefined;
  const audioMap = hasAudio ? (video.audioIndex !== undefined ? `-map 0:a:${video.audioIndex}` : '-map 0:a:0?') : '';
  
  const baseArgs = [
    ...(startSeconds !== undefined ? ['-ss', startSeconds.toString()] : []),
    '-i', video.path,
    '-map', '0:v:0',
    ...(hasAudio ? audioMap.split(' ') : []),
    '-map', '0:v:0',
    ...(hasAudio ? audioMap.split(' ') : []),
    '-sn' // disable subtitles for now to avoid crashes
  ];

  let v0Codec = 'libx264';
  let v0QualityArgs: string[] = [];

  if (video.streamType === 'remux' || video.streamType === 'direct') {
    v0Codec = 'copy';
  } else {
    v0QualityArgs = [
      '-preset:v:0', 'ultrafast',
      '-crf:v:0', '23',
      '-pix_fmt:v:0', 'yuv420p',
      '-profile:v:0', 'main'
    ];
  }

  ffmpegArgs = [
    ...baseArgs,
    
    // V0: Original/1080p
    '-c:v:0', v0Codec,
    ...v0QualityArgs,
    
    // V1: 720p
    '-s:v:1', '1280x720',
    '-c:v:1', 'libx264',
    '-preset:v:1', 'ultrafast',
    '-crf:v:1', '26',
    '-pix_fmt:v:1', 'yuv420p',
    '-profile:v:1', 'main',
    '-b:v:1', '2500k',
    '-maxrate:v:1', '2500k',
    '-bufsize:v:1', '5000k',
    
    // Audio (only if it exists)
    ...(hasAudio ? [
      '-c:a', 'aac',
      '-ac', '2',
      '-b:a', '128k',
      '-async', '1'
    ] : []),
    
    // HLS output
    '-f', 'hls',
    '-var_stream_map', hasAudio ? 'v:0,a:0 v:1,a:1' : 'v:0 v:1',
    '-master_pl_name', 'master.m3u8',
    '-hls_time', '4',
    '-hls_list_size', '0',
    '-hls_playlist_type', 'event',
    '-hls_segment_type', 'fmp4',
    '-hls_segment_filename', path.join(streamDir, 'v%v_prog%d.m4s'),
    path.join(streamDir, 'v%v_prog.m3u8')
  ];

  console.log(`Starting FFmpeg for ${video.id}`);

  const ffmpeg = spawn(ffmpegStatic!, ffmpegArgs);
  activeTranscodes.set(video.id, ffmpeg);

  const timeoutInterval = setInterval(() => {
    const last = lastActivity.get(video.id) || 0;
    if (Date.now() - last > 30000) {
      console.log(`Stream ${video.id} timed out due to inactivity. Killing FFmpeg.`);
      ffmpeg.kill('SIGKILL');
      clearInterval(timeoutInterval);
    }
  }, 10000);

  ffmpeg.stderr.on('data', (data) => {
    console.error(`ffmpeg stderr: ${data}`); // Optional: keep it silenced to avoid flooding
  });

  ffmpeg.on('close', (code) => {
    console.log(`FFmpeg for ${video.id} exited with code ${code}`);
    clearInterval(timeoutInterval);
    if (activeTranscodes.get(video.id) === ffmpeg) {
      activeTranscodes.delete(video.id);
      fs.rm(streamDir, { recursive: true, force: true }).catch((e) => {
        console.error(`Failed to clean up stream dir for ${video.id}:`, e);
      });
    }
  });

  return streamDir;
}

export async function cleanupStreams() {
  const streamsDir = path.join(process.cwd(), 'streams');
  try {
    await fs.rm(streamsDir, { recursive: true, force: true });
  } catch (e) {
    console.log('No streams to cleanup or failed');
  }
}
