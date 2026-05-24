import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "T-vic — Trace Viewer",
  description: "Datadog for voice: turn waterfalls, latency, interruptions, and audio replay.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
