import type { Metadata } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { Providers } from "@/components/providers";
import "./globals.css";

export const metadata: Metadata = {
    title: { default: "Ranobe TL", template: "%s · Ranobe TL" },
    description: "Self-hosted LLM translation of web novels with a growing glossary",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en" suppressHydrationWarning className={`${GeistSans.variable} ${GeistMono.variable}`}>
            <body className="min-h-dvh font-sans">
                <Providers>{children}</Providers>
            </body>
        </html>
    );
}
