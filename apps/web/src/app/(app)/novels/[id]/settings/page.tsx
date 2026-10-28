import { TranslationConfigSchema } from "@ranobe-tl/core";
import { DeleteNovel } from "@/components/novel/delete-novel";
import { NovelForm } from "@/components/novel/novel-form";
import { SettingsForm } from "@/components/novel/settings-form";
import { listKeys, getNovel } from "@/server/queries";
import { novelSettings } from "@/server/novel-config";

export default async function NovelSettingsPage({ params }: { params: Promise<{ id: string }> }) {
    const id = Number((await params).id);
    const [{ novel: n }, keys] = await Promise.all([getNovel(id), listKeys()]);
    const defaults = TranslationConfigSchema.parse({});
    return (
        <div className="mx-auto grid w-full max-w-3xl gap-8 px-4 py-6 sm:px-6 lg:px-8">
            <section className="rounded-xl border bg-card p-6 shadow-xs">
                <NovelForm
                    novelId={id}
                    keys={keys}
                    initial={{
                        title: n.title,
                        originalTitle: n.originalTitle,
                        synopsis: n.synopsis,
                        sourceLanguage: n.sourceLanguage,
                        targetLanguage: n.targetLanguage,
                        providerKeyId: n.providerKeyId,
                        model: n.model,
                        decisionMode: n.decisionMode,
                    }}
                />
            </section>
            <section className="rounded-xl border bg-card p-6 shadow-xs">
                <SettingsForm
                    novelId={id}
                    settings={novelSettings(n)}
                    defaults={{
                        maxOutputTokens: defaults.maxOutputTokens,
                        chunkSize: defaults.chunkSize,
                        contextChars: defaults.contextChars,
                        maxAttempts: defaults.maxAttempts,
                        patternsToRemove: defaults.patternsToRemove,
                        validation: defaults.validation,
                    }}
                />
            </section>
            <DeleteNovel novelId={id} title={n.title} />
        </div>
    );
}
