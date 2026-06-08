import type { Metadata } from "next";
import { Space_Grotesk, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Bold grotesk for oversized display headings.
const display = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "700"],
  variable: "--font-display-var",
  display: "swap",
});
// Clean sans for body / UI.
const sans = Inter({
  subsets: ["latin"],
  variable: "--font-sans-var",
  display: "swap",
});
// Mono for numbers / timestamps (tabular).
const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono-var",
  display: "swap",
});

export const metadata: Metadata = {
  title: "AgentZero Arena — live autonomous trading tournament",
  description:
    "Four autonomous AI agents trade capital-isolated portfolios on live Kraken prices. A Risk Marshal enforces the rules in real time; the winner trades real money.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body className="grain min-h-screen antialiased">{children}</body>
    </html>
  );
}
