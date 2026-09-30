// Display capture page — used when the user chooses a screen, window, or
// desktop. getDisplayMedia must originate from this visible, user-clicked page.

import type { VideoConfig } from "@/lib/types";

const params = new URLSearchParams(location.search);
const sessionId = params.get("sessionId") ?? "";
const tabTitle = params.get("tabTitle") ?? "the tab you're recording";
const filename = params.get("filename") ?? `chrome-recorder-fx-${sessionId}.webm`;
const tabStreamId = params.get("streamId");
const requestedConfig = JSON.parse(params.get("config") ?? "{}") as Partial<VideoConfig>;
const videoConfig: VideoConfig = {
  resolution: "720p",
  frameRate: 30,
  bitrate: 1500,
  format: "auto",
  microphone: true,
  source: "picker",
  ...requestedConfig,
};
const sourceDescription =
  tabStreamId
    ? `the current browser tab (${escapeHtml(tabTitle)})`
    : videoConfig.source === "desktop"
    ? "your entire desktop"
    : "the screen, window, or tab you want to test";

// biome-ignore lint/style/noNonNullAssertion: root element is always present in the bundled HTML
const root = document.getElementById("root")!;

function render(content: string) {
  root.innerHTML = content;
}

function showIdle() {
  render(`
    <h1>Video capture</h1>
    <p>${tabStreamId
      ? "Enable microphone access once to include narration. Future current-tab recordings start automatically."
      : `Select ${sourceDescription} in Chrome's protected share picker. Chrome requires a new share choice for every screen recording.`}</p>
    <button id="startBtn">${tabStreamId ? "Enable microphone &amp; start" : "Choose what to share"}</button>
  `);
  document.getElementById("startBtn")?.addEventListener("click", startCapture);
}

function showRecording() {
  render(`
    <h1>Video capture</h1>
    <div class="status"><div class="dot"></div>Recording — keep this tab open</div>
    <p>Switch back to <span class="tab-name">${escapeHtml(tabTitle)}</span> and reproduce the bug.
       Stop the session from the extension popup or with <kbd>Alt+Shift+S</kbd>.</p>
  `);
}

function showError(msg: string) {
  render(`
    <h1>Video capture</h1>
    <p class="error">Could not start recording: ${escapeHtml(msg)}</p>
    <button id="retryBtn">Try again</button>
  `);
  document.getElementById("retryBtn")?.addEventListener("click", showIdle);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

let recorder: MediaRecorder | null = null;
let writable: FileSystemWritableFileStream | null = null;
let stopped = false;
let microphoneStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;

async function startCapture() {
  try {
    // Do this directly in response to the button press. It is the reliable way
    // to surface Chrome's microphone permission prompt for extension capture.
    if (videoConfig.microphone) {
      microphoneStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    }
    const stream = tabStreamId
      ? await navigator.mediaDevices.getUserMedia({
          audio: {
            mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: tabStreamId },
          } as unknown as MediaTrackConstraints,
          video: {
            mandatory: {
              chromeMediaSource: "tab",
              chromeMediaSourceId: tabStreamId,
              maxFrameRate: videoConfig.frameRate,
            },
          } as unknown as MediaTrackConstraints,
        })
      : await navigator.mediaDevices.getDisplayMedia({
          video: {
            frameRate: videoConfig.frameRate,
            ...(videoConfig.source === "desktop" ? { displaySurface: "monitor" } : {}),
          },
          audio: true,
          ...(videoConfig.source === "tab" ? { preferCurrentTab: true } : {}),
        } as DisplayMediaStreamOptions);

    const mixed = new MediaStream(stream.getVideoTracks());
    if (stream.getAudioTracks().length > 0 || microphoneStream) {
      audioContext = new AudioContext();
      const destination = audioContext.createMediaStreamDestination();
      if (stream.getAudioTracks().length > 0) {
        audioContext.createMediaStreamSource(stream).connect(destination);
      }
      if (microphoneStream) {
        audioContext.createMediaStreamSource(microphoneStream).connect(destination);
      }
      for (const track of destination.stream.getAudioTracks()) mixed.addTrack(track);
    }

    const dir = await navigator.storage.getDirectory();
    const fileHandle = await dir.getFileHandle(filename, { create: true });
    writable = await fileHandle.createWritable();

    const mimeType = ["video/webm;codecs=vp9", "video/webm"].find((t) =>
      MediaRecorder.isTypeSupported(t)
    );

    recorder = new MediaRecorder(mixed, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: videoConfig.bitrate * 1000,
    });

    recorder.ondataavailable = async (e) => {
      if (e.data.size > 0 && writable) {
        await writable.write(await e.data.arrayBuffer());
      }
    };

    recorder.onstop = async () => {
      for (const t of stream.getTracks()) t.stop();
      for (const t of microphoneStream?.getTracks() ?? []) t.stop();
      microphoneStream = null;
      await audioContext?.close();
      audioContext = null;
      try {
        await writable?.close();
      } finally {
        writable = null;
      }
      chrome.runtime.sendMessage({ type: "fx-video-done", filename });
      window.close();
    };

    recorder.start(5_000);
    chrome.runtime.sendMessage({ type: "fx-video-ready", sessionId });
    showRecording();
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}

// Stop signal from background (sent when stop-session is called).
chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
  if (msg.type === "fx-video-stop" && recorder && !stopped) {
    stopped = true;
    recorder.stop();
  }
  return false;
});

// If the background service worker restarts while this tab is open, we can't
// recover state — just close gracefully so we don't leave a zombie tab.
chrome.runtime.onConnect.addListener(() => {});

async function initializeCapture(): Promise<void> {
  // A tabCapture stream ID was created from the popup's Start button. Once
  // Chrome has granted mic permission to this extension origin, both streams
  // can be acquired without another user confirmation.
  if (tabStreamId && !videoConfig.microphone) {
    await startCapture();
    return;
  }
  if (tabStreamId && videoConfig.microphone && navigator.permissions?.query) {
    try {
      const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
      if (status.state === "granted") {
        await startCapture();
        return;
      }
    } catch {
      // Some browsers do not expose the microphone permission descriptor.
    }
  }
  showIdle();
}

void initializeCapture();
