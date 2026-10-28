import { Logo } from "@/components/logo";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
    return (
        <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-4 py-12">
            <div
                aria-hidden
                className="pointer-events-none absolute inset-0 -z-10 opacity-60 [background:radial-gradient(60rem_30rem_at_50%_-10%,color-mix(in_oklch,var(--brand)_18%,transparent),transparent_70%)]"
            />
            <Logo className="mb-8 text-lg" />
            <div className="w-full max-w-sm">{children}</div>
            <p className="mt-10 max-w-sm text-center text-xs text-muted-foreground">
                Web novels translated chapter by chapter, with a glossary that keeps every name consistent.
            </p>
        </div>
    );
}
