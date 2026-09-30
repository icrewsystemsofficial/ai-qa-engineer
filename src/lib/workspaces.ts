import type { Session, SessionCounts } from "./types";

const RECORDINGS_KEY = "recordingWorkspaces";

export interface ArchivedRecording {
  id: string;
  domain: string;
  title: string;
  createdAt: number;
  session: Session;
  counts: SessionCounts;
  /** Exact OPFS filenames owned by this recording. */
  files: string[];
  bytes: number;
}

export interface RecordingWorkspace {
  domain: string;
  recordings: ArchivedRecording[];
  bytes: number;
}

function hostname(url: string | undefined): string {
  if (!url) return "unknown-site";
  try {
    return new URL(url).hostname || "unknown-site";
  } catch {
    return "unknown-site";
  }
}

export async function getArchivedRecordings(): Promise<ArchivedRecording[]> {
  const result = await chrome.storage.local.get(RECORDINGS_KEY);
  const recordings = result[RECORDINGS_KEY] as ArchivedRecording[] | undefined;
  return Array.isArray(recordings) ? recordings : [];
}

async function saveArchivedRecordings(recordings: ArchivedRecording[]): Promise<void> {
  await chrome.storage.local.set({ [RECORDINGS_KEY]: recordings });
}

export async function archiveRecording(
  session: Session,
  counts: SessionCounts,
  files: string[],
  bytes: number
): Promise<ArchivedRecording> {
  const recordings = await getArchivedRecordings();
  const existing = recordings.find((recording) => recording.id === session.id);
  if (existing) return existing;

  const recording: ArchivedRecording = {
    id: session.id,
    domain: hostname(session.tabUrl),
    title: session.tabTitle || hostname(session.tabUrl),
    createdAt: session.stoppedAt ?? Date.now(),
    session,
    counts,
    files,
    bytes,
  };
  await saveArchivedRecordings([recording, ...recordings]);
  return recording;
}

export async function getRecordingWorkspaces(): Promise<RecordingWorkspace[]> {
  const byDomain = new Map<string, ArchivedRecording[]>();
  for (const recording of await getArchivedRecordings()) {
    const entries = byDomain.get(recording.domain) ?? [];
    entries.push(recording);
    byDomain.set(recording.domain, entries);
  }
  return [...byDomain.entries()]
    .map(([domain, recordings]) => ({
      domain,
      recordings,
      bytes: recordings.reduce((total, recording) => total + recording.bytes, 0),
    }))
    .sort((a, b) => b.recordings[0].createdAt - a.recordings[0].createdAt);
}

export async function removeArchivedRecordings(ids: string[]): Promise<ArchivedRecording[]> {
  const idSet = new Set(ids);
  const recordings = await getArchivedRecordings();
  const removed = recordings.filter((recording) => idSet.has(recording.id));
  await saveArchivedRecordings(recordings.filter((recording) => !idSet.has(recording.id)));
  return removed;
}
