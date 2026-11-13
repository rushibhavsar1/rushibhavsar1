import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "DeskPilot", template: "%s · DeskPilot" },
  description: "Every new lead gets a personal reply in under 2 minutes — written in your voice, approved by you.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
