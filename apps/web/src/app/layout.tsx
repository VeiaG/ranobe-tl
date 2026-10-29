import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Providers } from "@/components/providers";
import "./globals.css";

const sans = Geist({ subsets: ["latin", "cyrillic"], variable: "--font-sans" });
const mono = Geist_Mono({ subsets: ["latin", "cyrillic"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
    title: { default: "Ranobe TL", template: "%s · Ranobe TL" },
    description: "Self-hosted LLM translation of web novels with a growing glossary",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en" suppressHydrationWarning className={`${sans.variable} ${mono.variable}`}>
            <body className="min-h-dvh font-sans">
                <Providers>{children}</Providers>
            </body>
        </html>
    );
}
