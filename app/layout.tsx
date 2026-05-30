import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentZero Arena",
  description:
    "A live, autonomous, multi-agent trading tournament on the Kraken CLI.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
