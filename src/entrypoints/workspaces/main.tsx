import { createRoot } from "react-dom/client";
import App from "./App";
import "@/assets/app.css";

// biome-ignore lint/style/noNonNullAssertion: root element is always present in the bundled HTML
createRoot(document.getElementById("root")!).render(<App />);
