import { Button } from "@/components/ui/button";
import { Logo } from "@/components/logo";
import { sendToBackground } from "@/lib/messaging";
import type { RecordingWorkspace } from "@/lib/types";
import { Archive, FileText, FolderOpen, HardDrive, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function App() {
  const [workspaces, setWorkspaces] = useState<RecordingWorkspace[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [expandedFiles, setExpandedFiles] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    sendToBackground<RecordingWorkspace[]>({ type: "get-recording-workspaces" })
      .then(setWorkspaces)
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const totalBytes = useMemo(
    () => workspaces.reduce((total, workspace) => total + workspace.bytes, 0),
    [workspaces]
  );
  const selectedBytes = useMemo(
    () =>
      workspaces
        .flatMap((workspace) => workspace.recordings)
        .filter((recording) => selected.includes(recording.id))
        .reduce((total, recording) => total + recording.bytes, 0),
    [selected, workspaces]
  );

  const toggle = (id: string) =>
    setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));

  const deleteSelected = async () => {
    if (selected.length === 0 || deleting) return;
    setDeleting(true);
    try {
      await sendToBackground<number>({ type: "delete-archived-recordings", ids: selected });
      setSelected([]);
      load();
    } finally {
      setDeleting(false);
    }
  };

  const openLocalFile = async (filename: string) => {
    try {
      const dir = await navigator.storage.getDirectory();
      const handle = await dir.getFileHandle(filename);
      const file = await handle.getFile();
      const url = URL.createObjectURL(file);
      window.open(url, "_blank", "noopener,noreferrer");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      // The recording may have been deleted from storage in another tab.
    }
  };

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-4xl px-4 py-8">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-primary">
              <Logo className="h-5 w-5" /> AI QA Engineer · Recording library
            </div>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">Domain workspaces</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Completed recordings are stored locally and grouped by the site where capture began.
            </p>
          </div>
          <div className="rounded-lg border border-border bg-card px-4 py-2 text-right">
            <div className="flex items-center gap-2 text-sm font-medium"><HardDrive className="h-4 w-4" /> {formatBytes(totalBytes)}</div>
            <p className="text-xs text-muted-foreground">recording storage</p>
          </div>
        </header>

        {selected.length > 0 && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <span>{selected.length} selected · {formatBytes(selectedBytes)}</span>
            <Button variant="destructive" size="sm" disabled={deleting} onClick={() => void deleteSelected()}>
              <Trash2 className="h-3.5 w-3.5" /> {deleting ? "Deleting…" : "Delete selected"}
            </Button>
          </div>
        )}

        {loading ? (
          <p className="py-12 text-center text-sm text-muted-foreground">Loading recordings…</p>
        ) : workspaces.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-12 text-center">
            <Archive className="mx-auto h-8 w-8 text-muted-foreground" />
            <p className="mt-3 font-medium">No saved recordings yet</p>
            <p className="mt-1 text-sm text-muted-foreground">Finish a recording to create its first domain workspace.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {workspaces.map((workspace) => (
              <section key={workspace.domain} className="overflow-hidden rounded-xl border border-border bg-card">
                <div className="flex items-center justify-between border-b border-border px-4 py-3">
                  <div>
                    <h2 className="font-medium">{workspace.domain}</h2>
                    <p className="text-xs text-muted-foreground">{workspace.recordings.length} recording{workspace.recordings.length === 1 ? "" : "s"}</p>
                  </div>
                  <span className="text-sm tabular-nums text-muted-foreground">{formatBytes(workspace.bytes)}</span>
                </div>
                <div className="divide-y divide-border">
                  {workspace.recordings.map((recording) => (
                    <div key={recording.id}>
                    <div className="flex items-center gap-3 px-4 py-3">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-primary"
                        checked={selected.includes(recording.id)}
                        onChange={() => toggle(recording.id)}
                        aria-label={`Select ${recording.title}`}
                      />
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL(`/recorder.html?recordingId=${recording.id}`) })}
                      >
                        <p className="truncate text-sm font-medium hover:underline">{recording.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(recording.createdAt).toLocaleString()} · {recording.counts.console} console · {recording.counts.network} network · {recording.counts.interactions} interactions
                        </p>
                      </button>
                      <span className="text-xs tabular-nums text-muted-foreground">{formatBytes(recording.bytes)}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="shrink-0 text-xs"
                        onClick={() => setExpandedFiles((current) => current === recording.id ? null : recording.id)}
                      >
                        <FolderOpen className="h-3.5 w-3.5" /> Files ({recording.files.length})
                      </Button>
                    </div>
                    {expandedFiles === recording.id && (
                      <div className="border-t border-border bg-muted/30 px-4 py-3">
                        <p className="mb-2 text-xs text-muted-foreground">Stored locally for this recording</p>
                        <ul className="grid gap-1">
                          {recording.files.map((filename) => (
                            <li key={filename}>
                              <button
                                type="button"
                                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-background"
                                onClick={() => void openLocalFile(filename)}
                              >
                                <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                                <span className="truncate font-mono">{filename}</span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
