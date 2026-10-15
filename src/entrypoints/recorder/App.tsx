import type { DebuggerActionEvent, DebuggerConsoleEvent } from "@/capture-core/debugger/types";
import { AnnotationCanvas } from "@/components/annotation/AnnotationCanvas";
import { DiagnosticsPanel } from "@/components/diagnostics-panel";
import { IncludeOptions, type IncludeRow, NetworkPrivacyReview } from "@/components/export-review";
import { Logo } from "@/components/logo";
import { ReplayPlayer } from "@/components/replay-player";
import "./recorder.css";
import { Accordion, AccordionItem } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MicButton } from "@/components/voice-input";
import type { Diagnostics } from "@/lib/diagnostics";
import { type ExportInclude, computeExportBaseName, exportReportAsZip } from "@/lib/export";
import { sendToBackground } from "@/lib/messaging";
import { domSnapshotOpfsFilename } from "@/lib/storage";
import {
  type ArchivedRecording,
  type CaptureConfig,
  DEFAULT_AI_CONTEXT_PROMPT,
  DEFAULT_CAPTURE_CONFIG,
  type NetworkFilterConfig,
  type RingSnapshot,
  type ScreenshotEntry,
  type Session,
  type SessionCounts,
  type SubmitFormValues,
} from "@/lib/types";
import {
  type DebuggerNetworkEvent as CoreNetworkEvent,
  type NetworkEdit,
  applyNetworkEdits,
  buildReportMd,
  buildReproSteps,
} from "@ai-qa-engineer/core";
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FolderOpen,
  GitBranch,
  ListTodo,
  MousePointer,
  PlayCircle,
  RotateCcw,
  Search,
  Trash2,
  Video,
  Tag,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

type AppState = "loading" | "annotating" | "form" | "submitting" | "success";

const AUTO_CLOSE_SECONDS = 3;

const BUILD_INFO_IDE_INSTRUCTIONS = `Add a standard application build metadata marker to the shared application layout so QA recordings can identify the build under test.

Render this exact element once on every application page (it may remain hidden):

<div id="app-build" hidden
  data-app-version="{{VERSION}}"
  data-app-branch="{{BRANCH}}"
  data-app-commit="{{COMMIT_SHA}}"
  data-app-built-at="{{ISO_8601_BUILD_TIMESTAMP}}"
  data-app-environment="{{ENVIRONMENT}}"></div>

Populate the values from the build or deployment pipeline. Keep the id and data attribute names exactly as written. Do not place secrets, API keys, or user-specific values in this element.`;

// Close this recorder tab. Opened via chrome.tabs.create (not window.open), so
// window.close() won't work — remove the tab by its own id instead.
async function closeRecorderTab(): Promise<void> {
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id != null) {
      await chrome.tabs.remove(tab.id);
      return;
    }
  } catch {
    // fall through
  }
  window.close();
}

interface DebuggerEvents {
  console: unknown[];
  network: unknown[];
  interactions: unknown[];
  websocket: unknown[];
  sse: unknown[];
  performance: unknown[];
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [meta, b64] = dataUrl.split(",");
  const mime = meta.match(/:(.*?);/)?.[1] ?? "image/png";
  const bytes = Uint8Array.from(atob(b64 ?? ""), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: mime });
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function applyAiContextPrompt(template: string, evidence: string): string {
  const prompt = template.trim();
  if (!prompt) return evidence;
  return prompt.includes("{{CONTEXT}}")
    ? prompt.replaceAll("{{CONTEXT}}", evidence)
    : `${prompt}\n\n${evidence}`;
}

function formatPlaybackDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}:${String(seconds).padStart(2, "0")}`
    : `0:${String(seconds).padStart(2, "0")}`;
}

export default function App() {
  const [state, setState] = useState<AppState>("loading");
  const [session, setSession] = useState<Session | null>(null);
  const [counts, setCounts] = useState<SessionCounts>({
    console: 0,
    network: 0,
    interactions: 0,
    websocket: 0,
    sse: 0,
    domSnapshots: 0,
    screenshots: 0,
    errors: 0,
  });
  const [screenshots, setScreenshots] = useState<ScreenshotEntry[]>([]);
  const [annotatingIndex, setAnnotatingIndex] = useState<number | null>(null);
  const [domSnapshots, setDomSnapshots] = useState<Record<string, string>>({});
  const [debuggerEvents, setDebuggerEvents] = useState<DebuggerEvents>({
    console: [],
    network: [],
    interactions: [],
    websocket: [],
    sse: [],
    performance: [],
  });
  const [formValues, setFormValues] = useState<SubmitFormValues>({
    title: "Bug report",
    description: "",
    notes: "",
  });
  const [replayEvents, setReplayEvents] = useState<unknown[]>([]);
  // Experimental: silence rrweb's sandboxed-iframe autofocus warning on replay.
  const [replayStripAutofocus, setReplayStripAutofocus] = useState(false);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [exportFilename, setExportFilename] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [videoDownloading, setVideoDownloading] = useState(false);
  const [autoClose, setAutoClose] = useState(true);
  const [closeCountdown, setCloseCountdown] = useState(AUTO_CLOSE_SECONDS);
  // Per-request review decisions (redact fields / drop) and per-artifact include
  // toggles, both applied at export time.
  const [networkEdits, setNetworkEdits] = useState<Record<number, NetworkEdit>>({});
  const [include, setInclude] = useState<ExportInclude>({
    console: true,
    network: true,
    interactions: true,
    screenshots: true,
    domSnapshots: true,
    replay: true,
    performance: true,
    video: true,
  });
  const [videoBytes, setVideoBytes] = useState(0);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [copyInclude, setCopyInclude] = useState({
    console: true,
    network: true,
    interactions: true,
  });
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const [buildInstructionsCopied, setBuildInstructionsCopied] = useState(false);
  const [aiContextPrompt, setAiContextPrompt] = useState(DEFAULT_AI_CONTEXT_PROMPT);
  const [interactionQuery, setInteractionQuery] = useState("");
  const [interactionFilter, setInteractionFilter] = useState<"all" | "click" | "navigation">("all");
  const [activeInteraction, setActiveInteraction] = useState<number | null>(null);
  const [branchName, setBranchName] = useState("");

  const modeRef = useRef<string | null>(null);
  const notesPrefilled = useRef(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    void sendToBackground<{ aiContextPrompt: string }>({ type: "get-settings" })
      .then(({ aiContextPrompt: prompt }) => setAiContextPrompt(prompt))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const mode = params.get("mode");
    modeRef.current = mode;

    // Pre-fill Notes with a "steps to reproduce" draft from the interaction log
    // so the submitter edits instead of facing a blank box. Never overwrites typing.
    function prefillNotes(interactions: DebuggerActionEvent[]) {
      if (notesPrefilled.current) return;
      const steps = buildReproSteps(interactions);
      if (!steps) return;
      notesPrefilled.current = true;
      setFormValues((v) => (v.notes.trim() ? v : { ...v, notes: steps }));
    }

    async function loadVideoSize(dir: FileSystemDirectoryHandle, filename: string | null) {
      if (!filename) return;
      try {
        const handle = await dir.getFileHandle(filename);
        const file = await handle.getFile();
        setVideoBytes(file.size);
        setVideoUrl((current) => {
          if (current) URL.revokeObjectURL(current);
          return URL.createObjectURL(file);
        });
      } catch {
        // video not yet flushed; size stays 0
      }
    }

    async function load() {
      try {
        let [sess, cnts] = await Promise.all([
          sendToBackground<Session | null>({ type: "get-session" }),
          sendToBackground<SessionCounts>({ type: "get-counts" }),
        ]);
        const recordingId = params.get("recordingId");
        if (recordingId) {
          const archived = await sendToBackground<ArchivedRecording | null>({
            type: "get-archived-recording",
            id: recordingId,
          });
          if (!archived) throw new Error("This saved recording is no longer available.");
          sess = archived.session;
          cnts = archived.counts;
        }
        setSession(sess);
        setCounts(cnts);

        sendToBackground<Diagnostics>({ type: "get-diagnostics" })
          .then(setDiagnostics)
          .catch(() => {});

        if (sess?.tabTitle) {
          setFormValues((v) => ({ ...v, title: sess.tabTitle ?? v.title }));
        }

        if (mode === "screenshot") {
          const ssResult = (await chrome.storage.session.get("screenshotFilenames")) as {
            screenshotFilenames?: string[];
          };
          const filenames = ssResult.screenshotFilenames ?? [];
          const opfsDir = await navigator.storage.getDirectory();
          const entries = await Promise.all(
            filenames.map(async (fn): Promise<ScreenshotEntry | null> => {
              try {
                const handle = await opfsDir.getFileHandle(fn);
                const file = await handle.getFile();
                const dataUrl = await fileToDataUrl(file);
                await opfsDir.removeEntry(fn).catch(() => {});
                return { dataUrl, annotatedBlob: null };
              } catch {
                return null;
              }
            })
          );
          await chrome.storage.session.remove("screenshotFilenames");
          const loaded = entries.filter((e): e is ScreenshotEntry => e !== null);
          setScreenshots(loaded);
          if (loaded.length > 0) {
            setAnnotatingIndex(loaded.length - 1);
            setState("annotating");
          } else {
            setState("form");
          }
          return;
        }

        if (mode === "snapshot") {
          const snapResult = (await chrome.storage.session.get("domSnapshotFilenames")) as {
            domSnapshotFilenames?: string[];
          };
          const filenames = snapResult.domSnapshotFilenames ?? [];
          const opfsDir = await navigator.storage.getDirectory();
          const snaps: Record<string, string> = {};
          let i = 1;
          for (const fn of filenames) {
            try {
              const handle = await opfsDir.getFileHandle(fn);
              const file = await handle.getFile();
              snaps[String(i)] = await file.text();
              await opfsDir.removeEntry(fn).catch(() => {});
              i++;
            } catch {
              // Skip unavailable snapshots
            }
          }
          await chrome.storage.session.remove("domSnapshotFilenames");
          setDomSnapshots(snaps);
          setCounts((c) => ({ ...c, domSnapshots: Object.keys(snaps).length }));
          setState("form");
          return;
        }

        if (mode === "ring") {
          const ringResult = (await chrome.storage.session.get("ringSnapshot")) as {
            ringSnapshot?: RingSnapshot;
          };
          const ring = ringResult.ringSnapshot;
          if (ring) {
            const ringSession: Session = {
              id: ring.id,
              tabId: -1,
              tabUrl: ring.tabUrl,
              tabTitle: ring.tabTitle,
              startedAt: ring.startedAt,
              status: "stopping",
              captureConfig: DEFAULT_CAPTURE_CONFIG,
              debuggerSessionId: null,
              domSnapshotCount: 0,
              domSnapshotKeys: [],
              screenshotFilenames: [],
              videoOpfsFilename: ring.videoOpfsFilename,
              replayOpfsFilename: null,
              eventsOpfsFilename: null,
              appBuild: null,
            };
            setSession(ringSession);
            setCounts({
              console: ring.console.length,
              network: ring.network.length,
              interactions: ring.interactions.length,
              websocket: 0,
              sse: 0,
              domSnapshots: 0,
              screenshots: 0,
              errors: 0,
            });
            setDebuggerEvents({
              console: ring.console,
              network: ring.network,
              interactions: ring.interactions,
              websocket: [],
              sse: [],
              performance: ring.performance ?? [],
            });
            setFormValues((v) => ({ ...v, title: ring.tabTitle ?? "Browser recording" }));
            prefillNotes(ring.interactions as DebuggerActionEvent[]);
            if (ring.videoOpfsFilename) {
              await loadVideoSize(await navigator.storage.getDirectory(), ring.videoOpfsFilename);
            }
          }
          setState("form");
          return;
        }

        const dir = await navigator.storage.getDirectory();
        void loadVideoSize(dir, sess?.videoOpfsFilename ?? null);

        const [loadedScreenshots, loadedSnaps] = await Promise.all([
          Promise.all(
            (sess?.screenshotFilenames ?? []).map(
              async (filename): Promise<ScreenshotEntry | null> => {
                try {
                  const handle = await dir.getFileHandle(filename);
                  const file = await handle.getFile();
                  const dataUrl = await fileToDataUrl(file);
                  return { dataUrl, annotatedBlob: null };
                } catch {
                  return null;
                }
              }
            )
          ),
          (async (): Promise<Record<string, string>> => {
            const snaps: Record<string, string> = {};
            await Promise.all(
              (sess?.domSnapshotKeys ?? []).map(async (key) => {
                try {
                  const filename = domSnapshotOpfsFilename(sess?.id ?? "", key);
                  const handle = await dir.getFileHandle(filename);
                  const file = await handle.getFile();
                  snaps[key] = await file.text();
                } catch {
                  // Skip unavailable snapshots
                }
              })
            );
            return snaps;
          })(),
        ]);

        setScreenshots(loadedScreenshots.filter((e): e is ScreenshotEntry => e !== null));
        setDomSnapshots(loadedSnaps);

        if (sess?.replayOpfsFilename) {
          try {
            const handle = await dir.getFileHandle(sess.replayOpfsFilename);
            const file = await handle.getFile();
            // Stored as NDJSON (one rrweb event per line) — the background appends
            // batches as they stream in.
            const events = (await file.text())
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line) as unknown);
            if (events.length > 0) setReplayEvents(events);
          } catch {
            // replay events unavailable; continue without them
          }
        }

        // Load debugger events from OPFS. The background flushes the write chain
        // before opening this tab, so the file is complete by the time we read it.
        // In crash recovery the in-memory bridge is gone; OPFS is the only source.
        if (sess?.eventsOpfsFilename) {
          try {
            const handle = await dir.getFileHandle(sess.eventsOpfsFilename);
            const file = await handle.getFile();
            const allEvents = (await file.text())
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line) as { kind?: string });
            if (allEvents.length > 0) {
              const consoleEvts: unknown[] = [];
              const networkEvts: unknown[] = [];
              const actionEvts: unknown[] = [];
              const wsEvts: unknown[] = [];
              const sseEvts: unknown[] = [];
              const perfEvts: unknown[] = [];
              for (const ev of allEvents) {
                if (ev.kind === "console") consoleEvts.push(ev);
                else if (ev.kind === "network") networkEvts.push(ev);
                else if (ev.kind === "action") actionEvts.push(ev);
                else if (ev.kind === "websocket") wsEvts.push(ev);
                else if (ev.kind === "sse") sseEvts.push(ev);
                else if (ev.kind === "performance") perfEvts.push(ev);
              }
              setDebuggerEvents({
                console: consoleEvts,
                network: networkEvts,
                interactions: actionEvts,
                websocket: wsEvts,
                sse: sseEvts,
                performance: perfEvts,
              });
              prefillNotes(actionEvts as DebuggerActionEvent[]);
            }
          } catch {
            // OPFS read failed — session exports with no events
          }
        }

        setState("form");
      } catch (err) {
        console.error("Recorder load error", err);
        setState("form");
      }
    }

    void load();
  }, []);

  function handleAnnotationDone(blob: Blob) {
    setScreenshots((prev) =>
      prev.map((entry, i) => (i === annotatingIndex ? { ...entry, annotatedBlob: blob } : entry))
    );
    setAnnotatingIndex(null);
    setState("form");
  }

  function openAnnotation(index: number) {
    setAnnotatingIndex(index);
    setState("annotating");
  }

  function handleDeleteScreenshot(index: number) {
    setScreenshots((prev) => prev.filter((_, i) => i !== index));
  }

  // A standalone screenshot/snapshot with exactly one artifact and no session
  // data has nothing to bundle — skip the zip and download the raw file.
  function singleFileExport(zipTitleFilename: boolean): { blob: Blob; filename: string } | null {
    const mode = modeRef.current;
    if (session || (mode !== "screenshot" && mode !== "snapshot")) return null;
    const snapKeys = Object.keys(domSnapshots);
    if (screenshots.length + snapKeys.length !== 1) return null;
    const baseName = computeExportBaseName(formValues, session, zipTitleFilename, new Date());
    if (screenshots.length === 1) {
      const { dataUrl, annotatedBlob } = screenshots[0];
      return { blob: annotatedBlob ?? dataUrlToBlob(dataUrl), filename: `${baseName}.png` };
    }
    const html = domSnapshots[snapKeys[0]];
    return { blob: new Blob([html], { type: "text/html" }), filename: `${baseName}.html` };
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setState("submitting");
    setExportError(null);
    try {
      const { captureConfig: exportConfig } = await sendToBackground<{
        captureConfig: CaptureConfig;
        networkFilter: NetworkFilterConfig;
      }>({ type: "get-settings" });

      const single = singleFileExport(exportConfig.zipTitleFilename);
      if (single) {
        downloadBlob(single.blob, single.filename);
        setExportFilename(single.filename);
        setState("success");
        return;
      }

      const { network: editedNetwork, redactedCount } = applyNetworkEdits(
        debuggerEvents.network as CoreNetworkEvent[],
        networkEdits
      );

      const filename = await exportReportAsZip({
        session,
        counts,
        formValues,
        screenshots,
        domSnapshots,
        debuggerEvents: { ...debuggerEvents, network: editedNetwork },
        replayEvents,
        diagnostics,
        nestInFolder: exportConfig.zipFolderNesting,
        zipTitleFilename: exportConfig.zipTitleFilename,
        include,
        redactedFieldCount: redactedCount,
      });
      setExportFilename(filename);
      if (modeRef.current === "ring") {
        if (session?.videoOpfsFilename) {
          const dir = await navigator.storage.getDirectory();
          await dir.removeEntry(session.videoOpfsFilename).catch(() => {});
        }
        await chrome.storage.session.remove("ringSnapshot");
      }
      setState("success");
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
      setState("form");
    }
  }

  async function handleVideoDownload() {
    const filename = session?.videoOpfsFilename;
    if (!filename) return;
    setVideoDownloading(true);
    try {
      const { captureConfig: dlConfig } = await sendToBackground<{
        captureConfig: CaptureConfig;
        networkFilter: NetworkFilterConfig;
      }>({ type: "get-settings" });
      const ext = filename.endsWith(".mp4") ? ".mp4" : ".webm";
      const baseName = computeExportBaseName(
        formValues,
        session,
        dlConfig.zipTitleFilename,
        new Date()
      );
      const dir = await navigator.storage.getDirectory();
      const fileHandle = await dir.getFileHandle(filename);
      const file = await fileHandle.getFile();
      const url = URL.createObjectURL(file);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${baseName}${ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      // File not yet available — user can retry
    } finally {
      setVideoDownloading(false);
    }
  }

  async function copyAiContext(context: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(context);
      setCopyStatus("copied");
      setTimeout(() => setCopyStatus("idle"), 2000);
    } catch {
      setCopyStatus("error");
    }
  }

  async function copyBuildInfoInstructions(): Promise<void> {
    try {
      await navigator.clipboard.writeText(BUILD_INFO_IDE_INSTRUCTIONS);
      setBuildInstructionsCopied(true);
      setTimeout(() => setBuildInstructionsCopied(false), 2000);
    } catch {
      setBuildInstructionsCopied(false);
    }
  }

  function handleReset() {
    setScreenshots((prev) => prev.map((s) => ({ ...s, annotatedBlob: null })));
    setExportFilename(null);
    setExportError(null);
    setState("form");
  }

  // Restart the countdown whenever the success screen is (re)entered.
  useEffect(() => {
    if (state === "success") setCloseCountdown(AUTO_CLOSE_SECONDS);
  }, [state]);

  // Load the current replay-preprocessing flag (a replay-viewing concern, so we
  // read live settings rather than the value baked into the session at record time).
  useEffect(() => {
    void (async () => {
      try {
        const { captureConfig } = await sendToBackground<{
          captureConfig: CaptureConfig;
          networkFilter: NetworkFilterConfig;
        }>({ type: "get-settings" });
        setReplayStripAutofocus(captureConfig.replayStripAutofocus);
      } catch {
        // Settings unavailable — leave the flag at its default (off).
      }
    })();
  }, []);

  // Tick the auto-close countdown and close the tab at zero.
  useEffect(() => {
    if (state !== "success" || !autoClose) return;
    if (closeCountdown <= 0) {
      void closeRecorderTab();
      return;
    }
    const id = setTimeout(() => setCloseCountdown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [state, autoClose, closeCountdown]);

  if (state === "loading") {
    return (
      <div className="recorder-shell flex min-h-screen items-center justify-center p-6">
        <span className="text-sm text-muted-foreground">Loading…</span>
      </div>
    );
  }

  if (state === "annotating" && annotatingIndex !== null) {
    const entry = screenshots[annotatingIndex];
    if (entry) {
      return (
        <AnnotationCanvas
          imageDataUrl={entry.dataUrl}
          onDone={handleAnnotationDone}
          onCancel={() => {
            setAnnotatingIndex(null);
            setState("form");
          }}
        />
      );
    }
  }

  if (state === "success") {
    return (
      <div className="recorder-shell flex min-h-screen items-center justify-center p-6">
        <div className="flex flex-col items-center gap-4 text-center max-w-sm">
          <CheckCircle2 className="h-12 w-12 text-green-500 dark:text-green-400" />
          <div>
            <p className="font-semibold text-lg">Recording downloaded</p>
            {exportFilename && <p className="text-sm font-medium mt-1">{exportFilename}</p>}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() =>
                chrome.tabs.create({
                  url:
                    import.meta.env.BROWSER === "firefox"
                      ? "about:downloads"
                      : "chrome://downloads",
                })
              }
            >
              <FolderOpen className="h-4 w-4" />
              Open Downloads
            </Button>
            <Button variant="ghost" onClick={handleReset}>
              <RotateCcw className="h-4 w-4" />
              Back to review
            </Button>
          </div>
          <div className="flex flex-col items-center gap-1.5">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={autoClose}
                onChange={(e) => setAutoClose(e.target.checked)}
                className="accent-primary"
              />
              Auto close
            </label>
            {autoClose && (
              <p className="text-xs text-muted-foreground">
                Auto closing in {closeCountdown} second{closeCountdown === 1 ? "" : "s"}…
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  const isSubmitting = state === "submitting";
  const domSnapshotKeys = Object.keys(domSnapshots);
  const isStandalone =
    !session && (modeRef.current === "screenshot" || modeRef.current === "snapshot");
  const isSingleFileExport = isStandalone && screenshots.length + domSnapshotKeys.length === 1;
  const singleFileLabel = screenshots.length === 1 ? "Download PNG" : "Download HTML";

  const jsonBytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
  const screenshotBytes = screenshots.reduce(
    (n, s) =>
      n + (s.annotatedBlob?.size ?? Math.floor((s.dataUrl.split(",")[1]?.length ?? 0) * 0.75)),
    0
  );
  const domBytes = Object.values(domSnapshots).reduce(
    (n, h) => n + new TextEncoder().encode(h).length,
    0
  );
  const includeRows: IncludeRow[] = [
    debuggerEvents.console.length > 0 && {
      key: "console",
      label: "Console",
      count: debuggerEvents.console.length,
      bytes: jsonBytes(debuggerEvents.console),
      toggleable: true,
    },
    debuggerEvents.network.length > 0 && {
      key: "network",
      label: "Network (+ WebSocket/SSE)",
      count: debuggerEvents.network.length,
      bytes: jsonBytes([
        ...debuggerEvents.network,
        ...debuggerEvents.websocket,
        ...debuggerEvents.sse,
      ]),
      toggleable: true,
    },
    debuggerEvents.interactions.length > 0 && {
      key: "interactions",
      label: "Interactions",
      count: debuggerEvents.interactions.length,
      bytes: jsonBytes(debuggerEvents.interactions),
      toggleable: true,
    },
    screenshots.length > 0 && {
      key: "screenshots",
      label: "Screenshots",
      count: screenshots.length,
      bytes: screenshotBytes,
      toggleable: true,
    },
    domSnapshotKeys.length > 0 && {
      key: "domSnapshots",
      label: "DOM snapshots",
      count: domSnapshotKeys.length,
      bytes: domBytes,
      toggleable: true,
    },
    replayEvents.length > 1 && {
      key: "replay",
      label: "Session replay (experimental)",
      bytes: jsonBytes(replayEvents),
      toggleable: true,
    },
    debuggerEvents.performance.length > 0 && {
      key: "performance",
      label: "Performance metrics (beta)",
      count: debuggerEvents.performance.length,
      bytes: jsonBytes(debuggerEvents.performance),
      toggleable: true,
    },
    session?.videoOpfsFilename && {
      key: "video",
      label: "Video",
      bytes: videoBytes,
      note: "also available as a separate download",
      toggleable: true,
    },
  ].filter(Boolean) as IncludeRow[];

  const { network: copySafeNetwork, redactedCount: copyRedactedCount } = applyNetworkEdits(
    debuggerEvents.network as CoreNetworkEvent[],
    networkEdits
  );
  const aiContext = buildReportMd(
    {
      title: formValues.title,
      description: formValues.description,
      notes: formValues.notes,
      url: session?.tabUrl,
      startedAt: session?.startedAt ?? null,
      consoleEvents: copyInclude.console ? (debuggerEvents.console as DebuggerConsoleEvent[]) : [],
      networkEvents: copyInclude.network ? copySafeNetwork : [],
      interactions: copyInclude.interactions
        ? (debuggerEvents.interactions as DebuggerActionEvent[])
        : [],
      redactedFieldCount: copyRedactedCount,
    },
    new Date()
  );
  const capturedBuild = session?.appBuild;
  const buildInfoSearchEnabled = session?.captureConfig.searchDomForBuildInfo ?? false;
  const buildContext = capturedBuild
    ? [
        "## Application build",
        "",
        "Version: " + (capturedBuild.version ?? "not provided"),
        "Branch: " + (capturedBuild.branch ?? "not provided"),
        "Commit: " + (capturedBuild.commit ?? "not provided"),
        "Built at: " + (capturedBuild.builtAt ?? "not provided"),
        "Environment: " + (capturedBuild.environment ?? "not provided"),
      ].join("\n")
    : buildInfoSearchEnabled
      ? [
        "## Application build",
        "",
        "Build information is not available in the captured page.",
        "Ask the AI to add the standard #app-build element with version, branch, commit, build timestamp, and environment to the application's shared layout.",
      ].join("\n")
      : [
          "## Application build",
          "",
          "Build information lookup was disabled for this recording.",
        ].join("\n");
  const aiCopyContext = applyAiContextPrompt(aiContextPrompt, aiContext + "\n\n" + buildContext);
  const navigationItems = (debuggerEvents.interactions as DebuggerActionEvent[])
    .map((ev, index) => {
      const meta = ev.metadata ?? {};
      const label = String(
        meta.label ??
          meta.text ??
          (ev.actionType === "navigation" ? (meta.path ?? meta.url) : ev.target) ??
          "Page interaction"
      );
      const seconds = session ? Math.max(0, (ev.timestamp - session.startedAt) / 1000) : 0;
      return { ev, index, label, seconds };
    })
    .filter(({ ev, label }) => {
      const matchesType = interactionFilter === "all" || ev.actionType === interactionFilter;
      const query = interactionQuery.trim().toLowerCase();
      return matchesType && (!query || `${ev.actionType} ${label}`.toLowerCase().includes(query));
    });
  const navigationCounts = {
    click: (debuggerEvents.interactions as DebuggerActionEvent[]).filter((event) => event.actionType === "click").length,
    navigation: (debuggerEvents.interactions as DebuggerActionEvent[]).filter(
      (event) => event.actionType === "navigation"
    ).length,
  };
  const sessionDuration = session
    ? formatPlaybackDuration((session.stoppedAt ?? Date.now()) - session.startedAt)
    : "0:00";
  const screenshotIndexByClickNumber = new Map<number, number>();
  for (const frame of session?.autoScreenshotClickFrames ?? []) {
    const screenshotIndex = session?.screenshotFilenames.indexOf(frame.filename) ?? -1;
    if (screenshotIndex >= 0) screenshotIndexByClickNumber.set(frame.clickNumber, screenshotIndex);
  }
  // Compatibility with recordings created before exact filename links existed.
  if (screenshotIndexByClickNumber.size === 0) {
    for (const [screenshotIndex, clickNumber] of (session?.autoScreenshotClickNumbers ?? []).entries()) {
      screenshotIndexByClickNumber.set(clickNumber, screenshotIndex);
    }
  }

  return (
    <div className="recorder-shell">
      <header className="recorder-masthead">
        <a className="recorder-brand" href="workspaces.html" aria-label="AI QA Engineer workspaces">
          <Logo className="recorder-logo" />
          <span>
            AI QA Engineer<span className="recorder-brand-caption">RECORDING STUDIO</span>
          </span>
        </a>
        <a className="recorder-workspace-link" href="workspaces.html">
          <FolderOpen size={16} /> Local workspaces <ChevronRight size={14} />
        </a>
      </header>

      <main className="recorder-main">
        <div className="recorder-title-row">
          <div className="recorder-title-block">
            <p className="recorder-eyebrow">Recording review</p>
            <h1>{formValues.title || "Untitled recording"}</h1>
            <div className="recorder-session-meta">
              <span className="recorder-source">{session?.tabUrl || "Standalone capture"}</span>
              {session && (
                <span>
                  {new Date(session.startedAt).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </span>
              )}
            </div>
          </div>
          {new URLSearchParams(window.location.search).has("recordingId") && (
            <span className="recorder-saved">
              <CheckCircle2 size={14} /> Saved locally
            </span>
          )}
        </div>

        <form onSubmit={handleSubmit} className="recorder-layout">
          <div className="recorder-evidence">
            <section className="recorder-playback" aria-labelledby="playback-title">
              <div className="recorder-section-heading">
                <h2 id="playback-title">
                  <Video size={16} /> Playback
                </h2>
                {videoUrl && (
                  <button
                    type="button"
                    className="recorder-text-button"
                    disabled={videoDownloading}
                    onClick={handleVideoDownload}
                  >
                    <Download size={14} />
                    {videoDownloading ? "Downloading…" : "Download video"}
                  </button>
                )}
              </div>
              {videoUrl ? (
                <div className="recorder-video-stage">
                  <div className="recorder-video-status" aria-label="Video recording details">
                    <span><i aria-hidden="true" /> Recorded session</span>
                    <span>{sessionDuration}</span>
                  </div>
                  {/* biome-ignore lint/a11y/useMediaCaption: recordings have no captured caption track; preserve existing audio playback */}
                  <video
                    ref={videoRef}
                    className="recorder-video"
                    aria-label="Recorded session with captured audio"
                    controls
                    src={videoUrl}
                  />
                </div>
              ) : (
                <div className="recorder-video-empty">
                  <PlayCircle size={38} strokeWidth={1} />
                  <h3>No video in this recording</h3>
                  <p>Captured interactions and screenshots are available below.</p>
                </div>
              )}
              <div className="recorder-playback-caption">
                <span>Session recording</span>
                <span>
                  {videoUrl
                    ? "Audio controls available in player"
                    : "Video was not captured or is unavailable"}
                </span>
              </div>
            </section>

            <section className="recorder-screenshots" aria-labelledby="screenshots-title">
              <div className="recorder-section-heading">
                <h2 id="screenshots-title">
                  <Camera size={16} /> Screenshots{" "}
                  <span className="recorder-count">{screenshots.length}</span>
                </h2>
                <span className="recorder-helper">Captured during this session</span>
              </div>
              {screenshots.length ? (
                <div className="recorder-gallery">
                  {screenshots.map((entry, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: captured screenshots have no stable id
                    <figure className="recorder-shot" key={i}>
                      <button
                        type="button"
                        className="recorder-shot-preview"
                        onClick={() => openAnnotation(i)}
                        aria-label={`Open screenshot ${i + 1} for annotation`}
                      >
                        <img src={entry.dataUrl} alt={`Captured screenshot ${i + 1}`} />
                      </button>
                      <figcaption>
                        <span>
                          <b>{String(i + 1).padStart(2, "0")}</b>{" "}
                          {entry.annotatedBlob ? "Annotated" : "Screenshot"}
                        </span>
                        <div>
                          <button type="button" onClick={() => openAnnotation(i)}>
                            Annotate
                          </button>
                          <button
                            type="button"
                            className="recorder-remove"
                            aria-label={`Remove screenshot ${i + 1}`}
                            onClick={() => handleDeleteScreenshot(i)}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </figcaption>
                    </figure>
                  ))}
                </div>
              ) : (
                <div className="recorder-empty">
                  <Camera size={20} />
                  <p>No screenshots captured in this session.</p>
                </div>
              )}
            </section>

            <Accordion className="recorder-details">
              <AccordionItem title="Recording details" description="Title, description & notes">
              <div className="recorder-details-body">
                <Label htmlFor="title">Title</Label>
                <Input
                  id="title"
                  value={formValues.title}
                  onChange={(e) => setFormValues((v) => ({ ...v, title: e.target.value }))}
                />
                <div className="flex items-center justify-between">
                  <Label htmlFor="description">Description</Label>
                  <MicButton
                    value={formValues.description}
                    onChange={(description) => setFormValues((v) => ({ ...v, description }))}
                  />
                </div>
                <Textarea
                  id="description"
                  rows={3}
                  value={formValues.description}
                  onChange={(e) => setFormValues((v) => ({ ...v, description: e.target.value }))}
                />
                <div className="flex items-center justify-between">
                  <Label htmlFor="notes">Notes & reproduction steps</Label>
                  <MicButton
                    value={formValues.notes}
                    onChange={(notes) => setFormValues((v) => ({ ...v, notes }))}
                  />
                </div>
                <Textarea
                  id="notes"
                  rows={4}
                  value={formValues.notes}
                  onChange={(e) => setFormValues((v) => ({ ...v, notes: e.target.value }))}
                />
              </div>
              </AccordionItem>
            </Accordion>
            <Accordion className="recorder-details">
              <AccordionItem title="Capture settings & privacy" description="Review technical details">
              <div className="recorder-details-body">
                <DiagnosticsPanel
                  captureConfig={session?.captureConfig ?? null}
                  counts={counts}
                  diagnostics={diagnostics}
                />
                <NetworkPrivacyReview
                  events={debuggerEvents.network as CoreNetworkEvent[]}
                  edits={networkEdits}
                  onChange={setNetworkEdits}
                  replayTabId={session?.tabId}
                />
                {replayEvents.length > 1 && (
                  <div>
                    <h3 className="mb-3 text-sm font-medium">Session replay · Experimental</h3>
                    <ReplayPlayer events={replayEvents} stripAutofocus={replayStripAutofocus} />
                  </div>
                )}
              </div>
              </AccordionItem>
            </Accordion>
          </div>

          <aside className="recorder-sidebar" aria-label="Interactions and export">
            <section className="recorder-change-context" aria-labelledby="change-context-title">
              <div className="recorder-change-context-heading">
                <GitBranch size={16} />
                <h2 id="change-context-title">Change context</h2>
              </div>
              <label>
                <span>Branch / task</span>
                <input
                  value={branchName}
                  onChange={(event) => setBranchName(event.target.value)}
                  placeholder={capturedBuild?.branch ?? "e.g. sam_task_123"}
                  aria-label="Branch or task reference"
                />
              </label>
              {capturedBuild ? (
                <div className="recorder-build-values">
                  <span><Tag size={13} /> v{capturedBuild.version ?? "unknown"}</span>
                  <span>{capturedBuild.commit ? "commit " + capturedBuild.commit : "commit unavailable"}</span>
                  <span>{capturedBuild.environment ?? "environment unavailable"}</span>
                  {capturedBuild.builtAt && <span>{new Date(capturedBuild.builtAt).toLocaleString()}</span>}
                </div>
              ) : (
                <div className="recorder-build-missing">
                  <p className="recorder-build-unavailable">
                    {buildInfoSearchEnabled
                      ? <>Build info was not found. Add the shared <code>#app-build</code> layout marker.</>
                      : <>Build info lookup was disabled for this recording.</>}
                  </p>
                  {buildInfoSearchEnabled && (
                    <button type="button" className="recorder-build-copy" onClick={copyBuildInfoInstructions}>
                      <Copy size={13} /> {buildInstructionsCopied ? "Instructions copied" : "Copy instructions for IDE"}
                    </button>
                  )}
                </div>
              )}
              <div className="recorder-version"><Tag size={13} /> Extension v{chrome.runtime.getManifest().version}</div>
            </section>

            <section className="recorder-reproduction-notes" aria-labelledby="reproduction-notes-title">
              <div className="recorder-reproduction-notes-heading">
                <ListTodo size={16} />
                <h2 id="reproduction-notes-title">Notes &amp; reproduction steps</h2>
              </div>
              {formValues.notes.trim() ? (
                <p>{formValues.notes}</p>
              ) : (
                <p className="recorder-notes-empty">No notes yet. Add them in Recording details.</p>
              )}
            </section>

            <section className="recorder-timeline" aria-labelledby="interactions-title">
              <div className="recorder-section-heading">
                <h2 id="interactions-title">
                  <MousePointer size={16} /> Session navigation{" "}
                  <span className="recorder-count">{debuggerEvents.interactions.length}</span>
                </h2>
                <span className="recorder-helper">Jump to evidence</span>
              </div>
              <div className="recorder-navigation-tools">
                <label className="recorder-navigation-search">
                  <Search size={14} />
                  <input
                    type="search"
                    value={interactionQuery}
                    onChange={(e) => setInteractionQuery(e.target.value)}
                    placeholder="Find an interaction"
                    aria-label="Find an interaction"
                  />
                </label>
                <div className="recorder-navigation-filters" role="group" aria-label="Filter interactions">
                  {(["all", "click", "navigation"] as const).map((filter) => (
                    <button
                      type="button"
                      key={filter}
                      className={interactionFilter === filter ? "is-active" : ""}
                      onClick={() => setInteractionFilter(filter)}
                    >
                      {filter === "all"
                        ? `All ${debuggerEvents.interactions.length}`
                        : filter === "click"
                          ? `Clicks ${navigationCounts.click}`
                          : `Pages ${navigationCounts.navigation}`}
                    </button>
                  ))}
                </div>
              </div>
              {debuggerEvents.interactions.length ? (
                <ol
                  className="recorder-events"
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: allow keyboard scrolling of the timeline
                  tabIndex={0}
                  aria-label="Recorded interaction timeline"
                >
                  {navigationItems.map(({ ev, index, label, seconds }) => {
                    const clickNumber = Number(ev.metadata?.clickNumber);
                    const screenshotIndex = Number.isFinite(clickNumber)
                      ? screenshotIndexByClickNumber.get(clickNumber)
                      : undefined;
                    const linkedScreenshot = screenshotIndex === undefined ? undefined : screenshots[screenshotIndex];
                    const eventTypeLabel = ev.actionType === "click" && Number.isFinite(clickNumber)
                      ? `Click #${clickNumber}`
                      : ev.actionType;
                    return (
                      <li className="recorder-event-row" data-action={ev.actionType} key={`${ev.timestamp}-${index}`}>
                        <button
                          type="button"
                          className={activeInteraction === index ? "is-active" : ""}
                          onClick={() => {
                            setActiveInteraction(index);
                            if (videoRef.current) {
                              videoRef.current.currentTime = seconds;
                              void videoRef.current.play().catch(() => {});
                            }
                          }}
                        >
                          <time className="recorder-event-time">
                            {`${Math.floor(seconds / 60).toString().padStart(2, "0")}:${Math.floor(seconds % 60)
                              .toString()
                              .padStart(2, "0")}`}
                          </time>
                          <span className="recorder-event-type">{eventTypeLabel}</span>
                          <span className="recorder-event-label" title={label}>{label}</span>
                          {linkedScreenshot && (
                            <span className="recorder-event-screenshot">
                              <Camera size={14} aria-label="Screenshot captured for this interaction" />
                              <span className="recorder-event-screenshot-popover" role="tooltip">
                                <img src={linkedScreenshot.dataUrl} alt={`Screenshot for click ${clickNumber}`} />
                              </span>
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <div className="recorder-empty">
                  <MousePointer size={20} />
                  <p>No interactions captured.</p>
                </div>
              )}
            </section>

            <section className="recorder-handoff" aria-labelledby="context-title">
              <div className="recorder-handoff-heading">
                <span className="recorder-eyebrow">Continue your work</span>
                <h2 id="context-title">Take the context with you.</h2>
                <p>Choose what your AI receives.</p>
              </div>
              <fieldset className="recorder-copy-options">
                <legend className="sr-only">Include in AI context</legend>
                {(
                  [
                    ["interactions", "Interactions", debuggerEvents.interactions.length],
                    ["console", "Console logs", debuggerEvents.console.length],
                    ["network", "Network requests", debuggerEvents.network.length],
                  ] as const
                ).map(([key, label, count]) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={copyInclude[key]}
                      onChange={() => setCopyInclude((v) => ({ ...v, [key]: !v[key] }))}
                    />
                    <span>{label}</span>
                    <small>{count}</small>
                  </label>
                ))}
              </fieldset>
              <Button
                type="button"
                className="recorder-copy-button"
                onClick={() => void copyAiContext(aiCopyContext)}
              >
                {copyStatus === "copied" ? <CheckCircle2 size={16} /> : <Copy size={16} />}
                <span aria-live="polite">
                  {copyStatus === "copied"
                    ? "Copied to clipboard"
                    : copyStatus === "error"
                      ? "Could not copy — try again"
                      : "Copy context for AI"}
                </span>
              </Button>
              <p className="recorder-copy-note">Title and notes included. Ready to paste.</p>
              <div className="recorder-save-section">
                <div className="recorder-save-heading">
                  <FolderOpen size={18} />
                  <div>
                    <h3>Keep a local copy</h3>
                    <p>
                      Review saved recordings in <a href="workspaces.html">local workspaces</a>.
                    </p>
                  </div>
                </div>
                {!isSingleFileExport && (
                  <details className="recorder-package">
                    <summary>
                      Choose download contents <ChevronDown size={14} />
                    </summary>
                    <IncludeOptions
                      rows={includeRows}
                      value={include as unknown as Record<string, boolean>}
                      onToggle={(key) =>
                        setInclude((v) => ({ ...v, [key]: !v[key as keyof ExportInclude] }))
                      }
                      heading="Include in download"
                      description="Only selected artifacts are added to your ZIP."
                    />
                  </details>
                )}
                <Button
                  type="submit"
                  disabled={isSubmitting}
                  variant="outline"
                  className="recorder-download-button"
                >
                  <Download size={16} />
                  {isSubmitting
                    ? "Preparing download…"
                    : isSingleFileExport
                      ? singleFileLabel
                      : "Download recording"}
                </Button>
                {exportError && (
                  <p role="alert" className="recorder-error">
                    <AlertTriangle size={14} />
                    {exportError}
                  </p>
                )}
              </div>
            </section>
          </aside>
        </form>
        <footer className="recorder-footer">
          <span>AI QA Engineer</span>
          <span>Review. Understand. Reproduce.</span>
        </footer>
      </main>
    </div>
  );
}
