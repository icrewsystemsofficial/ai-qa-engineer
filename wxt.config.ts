import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import { type Plugin, defineConfig } from "wxt";

// Single source of truth for the repo URL: package.json → manifest.homepage_url →
// chrome.runtime.getManifest() at runtime. Keeps the repo slug out of the code.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  homepage?: string;
};

const rrwebReplayRuntime = readFileSync(
  new URL("./node_modules/rrweb/dist/rrweb.umd.min.cjs", import.meta.url),
  "utf8"
).replace(
  /[\uFDD0-\uFDEF\uFFFE\uFFFF]/g,
  (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`
);

function packageRrwebReplayRuntime(): Plugin {
  return {
    name: "package-rrweb-replay-runtime",
    generateBundle(_options, bundle) {
      const runtimeIsReferenced = Object.values(bundle).some(
        (file) => file.type === "chunk" && file.code.includes("/assets/rrweb-replay.js")
      );
      if (!runtimeIsReferenced) return;
      this.emitFile({
        type: "asset",
        fileName: "assets/rrweb-replay.js",
        source: rrwebReplayRuntime,
      });
    },
  };
}

// chrome.scripting.executeScript validates injected files with base::IsStringUTF8,
// which rejects Unicode *non-characters* (U+FDD0–U+FDEF, U+FFFE/U+FFFF) even though
// they're valid UTF-8. rrweb's bundle embeds a raw U+FFFE in its CSS-BOM check, so
// the injected replay-record.js fails to load with "isn't UTF-8 encoded". Escaping
// those code points to \uXXXX keeps the strings identical at runtime while making
// the file bytes injectable. Targeted (not a full ASCII pass) to minimize churn.
function escapeUtf8NonCharacters(): Plugin {
  return {
    name: "escape-utf8-noncharacters",
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== "chunk") continue;
        file.code = file.code.replace(
          /[\uFDD0-\uFDEF\uFFFE\uFFFF]/g,
          (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`
        );
      }
    },
  };
}

export default defineConfig({
  srcDir: "src",
  modules: ["@wxt-dev/module-react"],
  vite: () => ({
    plugins: [tailwindcss(), packageRrwebReplayRuntime(), escapeUtf8NonCharacters()],
  }),
  manifest: ({ browser }) => {
    const isFirefox = browser === "firefox";
    return {
      name: "AI QA Engineer",
      short_name: "AI QA",
      description: "Capture console, network, interactions and DOM snapshots for bug reports",
      ...(pkg.homepage && { homepage_url: pkg.homepage }),
      action: {
        default_title: "AI QA Engineer",
        default_popup: "popup.html",
      },
      options_ui: {
        page: "options.html",
        open_in_tab: true,
      },
      icons: {
        16: "icon/favicon-16x16.png",
        32: "icon/favicon-32x32.png",
        128: "icon/android-chrome-192x192.png",
      },
      commands: {
        "start-session": {
          description: "Start capture session",
          suggested_key: { default: "Alt+Shift+R", mac: "Alt+Shift+R" },
        },
        "stop-session": {
          description: "Stop session and open report",
          suggested_key: { default: "Alt+Shift+S", mac: "Alt+Shift+S" },
        },
        "take-screenshot": {
          description: "Take screenshot (standalone or during session)",
          suggested_key: { default: "Alt+Shift+C", mac: "Alt+Shift+C" },
        },
        "snapshot-dom": {
          description: "Capture DOM snapshot (standalone or during session)",
          suggested_key: { default: "Alt+Shift+D", mac: "Alt+Shift+D" },
        },
      },
      permissions: [
        "activeTab",
        "management",
        "scripting",
        "storage",
        "tabs",
        ...(!isFirefox ? (["tabCapture", "offscreen"] as const) : []),
      ],
      host_permissions: ["<all_urls>"],
      ...(isFirefox && {
        browser_specific_settings: {
          gecko: {
            id: "ai-qa-engineer@icrewsystems.com",
            strict_min_version: "128.0",
            data_collection_permissions: {
              required: ["none"],
            },
          },
        },
      }),
    };
  },
  manifestVersion: 3,
  zip: {
    excludeSources: ["scratch/**"],
  },
});
