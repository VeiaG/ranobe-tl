import * as p from "@clack/prompts";
import chalk from "chalk";
import { type Change, type Gender, type GlossaryStore, genderAt } from "../glossary/store.js";

/** Pending changes grouped by term and field, so competing proposals are decided together. */
function groupChanges(changes: Change[]): Change[][] {
    const groups = new Map<string, Change[]>();
    for (const c of changes) {
        const key = `${c.termId}:${c.field}`;
        groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    return [...groups.values()];
}

function describe(group: Change[]): string {
    return group
        .map((c) => {
            const lines = [`${chalk.green(c.newValue)} ${chalk.dim(`ch.${c.chapter ?? "?"}`)}`];
            if (c.reason) lines.push(chalk.dim(`  why: ${c.reason}`));
            if (c.evidence) lines.push(chalk.dim(`  evidence: "${c.evidence}"`));
            return lines.join("\n");
        })
        .join("\n");
}

/** Interactive review of queued glossary changes. */
export async function reviewCommand(store: GlossaryStore): Promise<void> {
    if (!process.stdin.isTTY) {
        throw new Error('glossary review needs an interactive terminal; use "glossary changes" / "accept" / "reject" instead');
    }
    const groups = groupChanges(store.listChanges("pending"));
    p.intro(`Glossary review · ${groups.length} terms with pending changes`);
    if (!groups.length) {
        p.outro("Nothing to review");
        return;
    }

    const stats = { applied: 0, kept: 0, skipped: 0 };

    for (const [i, group] of groups.entries()) {
        const term = store.getTerm(group[0].termId);
        if (!term) continue;
        const field = group[0].field;
        const latestChapter = Math.max(...group.map((c) => c.chapter ?? 0));
        const current = field === "target" ? term.target : (genderAt(term, latestChapter) ?? "unknown");

        p.note(
            `${chalk.bold(term.source)} → ${chalk.bold(term.target)} ${chalk.dim(`[${term.type}${term.note ? `, ${term.note}` : ""}]`)}\n` +
                `${field === "target" ? "translation" : "gender"} now: ${chalk.yellow(current)}\n\nproposed:\n${describe(group)}`,
            `${i + 1}/${groups.length}`
        );

        const values = [...new Set(group.map((c) => c.newValue))];
        // option values: "keep" | "custom" | "skip" | "quit" | "use:<index into values>"
        const choice = await p.select<string>({
            message: field === "target" ? "Translation" : "Gender",
            options: [
                { value: "keep", label: `Keep "${current}"` },
                ...values.map((v, n) => ({ value: `use:${n}`, label: `Use "${v}"` })),
                ...(field === "target" ? [{ value: "custom", label: "Type my own…" }] : []),
                { value: "skip", label: "Skip for now" },
                { value: "quit", label: "Quit" },
            ],
        });
        if (p.isCancel(choice) || choice === "quit") break;
        if (choice === "skip") {
            stats.skipped++;
            continue;
        }

        let value: string | undefined;
        if (choice.startsWith("use:")) value = values[Number(choice.slice(4))];
        if (choice === "custom") {
            const typed = await p.text({ message: `Translation for "${term.source}"`, initialValue: term.target });
            if (p.isCancel(typed)) break;
            value = typed.trim() || undefined;
        }

        store.transaction(() => {
            for (const c of group) store.setChangeStatus(c.id, value !== undefined && c.newValue === value ? "applied" : "rejected");
            if (value === undefined) return;
            if (field === "target") {
                store.updateTerm(term.id, { target: value });
                if (choice === "custom") {
                    store.addChange({
                        termId: term.id, field, oldValue: term.target, newValue: value,
                        chapter: null, evidence: "", reason: "set during review", status: "applied",
                    });
                }
            } else {
                const from = group.find((c) => c.newValue === value)?.chapter ?? 1;
                store.setGender(term.id, from, value as Gender);
            }
        });
        if (value === undefined) stats.kept++;
        else stats.applied++;

        if (field === "target") {
            const lock = await p.confirm({ message: `Lock "${term.source}" so the model stops proposing changes?`, initialValue: false });
            if (p.isCancel(lock)) break;
            if (lock) store.updateTerm(term.id, { locked: true });
        }
    }

    const left = store.listChanges("pending").length;
    p.outro(`${stats.applied} changed, ${stats.kept} kept, ${stats.skipped} skipped${left ? ` · ${left} changes still pending` : ""}`);
}
