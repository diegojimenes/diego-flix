import fs from 'fs/promises';
import path from 'path';

const HISTORY_PATH = path.join(process.cwd(), 'history.json');

export interface HistoryEntry {
  videoId: string;
  progress: number;
  duration: number;
  watched: boolean;
  lastUpdated: number;
}

export async function getHistory(): Promise<Record<string, HistoryEntry>> {
  try {
    const data = await fs.readFile(HISTORY_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

export async function saveHistory(history: Record<string, HistoryEntry>): Promise<void> {
  await fs.writeFile(HISTORY_PATH, JSON.stringify(history, null, 2), 'utf-8');
}

export async function updateHistory(videoId: string, progress: number, duration: number, watched: boolean): Promise<void> {
  const history = await getHistory();
  history[videoId] = {
    videoId,
    progress,
    duration,
    watched,
    lastUpdated: Date.now()
  };
  await saveHistory(history);
}
