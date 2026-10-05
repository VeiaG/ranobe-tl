import { promises as fs } from "node:fs";
import path from "node:path";
import chalk from "chalk";
import type { Config } from "../config.js";
import { importLegacy } from "../glossary/importLegacy.js";
import { normalizeTerm } from "../glossary/normalize.js";
import { Gender, GlossaryStore, TERM_TYPES, Term, TermType } from "../glossary/store.js";

export interface GlossaryOpts {
    target?: string;
    gender?: string;
    from?: number;
    type?: string;
    note?: string;
    all?: boolean;
}

function formatTerm(t: Term): string {
    const genders = t.genders.map((g) => `${g.gender}@${g.fromChapter}`).join(" → ");
    const meta = [t.type, genders, t.note, t.locked ? "locked" : "", t.firstChapter ? `ch.${t.firstChapter}` : ""].filter(Boolean);
    return `${t.source} → ${chalk.bold(t.target)} ${chalk.dim(`[${meta.join(", ")}]`)}`;
}

export async function glossaryCommand(config: Config, args: string[], opts: GlossaryOpts): Promise<void> {
    const store = new GlossaryStore(path.resolve(config.root, config.glossaryFile));
    const [sub, ...rest] = args;
    const arg = rest.join(" ");
    const need = (term: string) => {
        const t = store.findTerm(term);
        if (!t) throw new Error(`term not found: ${term}`);
        return t;
    };

    try {
        switch (sub) {
            case "import": {
                const file = path.resolve(config.root, arg || "meta.json");
                const memory = JSON.parse(await fs.readFile(file, "utf-8"));
                const res = importLegacy(store, memory);
                console.log(chalk.green(`imported ${res.imported} terms, ${res.existing} already existed`));
                for (const d of res.duplicates) console.log(chalk.yellow(`  duplicate skipped: "${d.skipped}" (kept "${d.kept}")`));
                break;
            }
            case "export": {
                const data = store.allTerms().map(({ id, ...t }) => t);
                const json = JSON.stringify(data, null, 2);
                if (arg) await fs.writeFile(path.resolve(config.root, arg), json, "utf-8");
                else console.log(json);
                break;
            }
            case "list":
            case "search": {
                const q = normalizeTerm(arg);
                const terms = store.allTerms().filter(
                    (t) => !q || normalizeTerm(t.source).includes(q) || t.target.toLowerCase().includes(q)
                );
                for (const t of terms.filter((t) => !opts.type || t.type === opts.type)) console.log(formatTerm(t));
                break;
            }
            case "show":
                console.log(formatTerm(need(arg)));
                for (const c of store.listChanges().filter((c) => c.termId === need(arg).id)) {
                    console.log(chalk.dim(`  #${c.id} ${c.status} ${c.field}: ${c.oldValue} → ${c.newValue} (ch.${c.chapter})`));
                }
                break;
            case "changes": {
                const changes = store.listChanges(opts.all ? undefined : "pending");
                if (!changes.length) console.log(chalk.dim("nothing to review"));
                for (const c of changes) {
                    console.log(
                        `${chalk.bold(`#${c.id}`)} ${c.status === "pending" ? "" : chalk.dim(c.status + " ")}${c.source}: ${c.field} ` +
                            `${chalk.red(c.oldValue)} → ${chalk.green(c.newValue)} ${chalk.dim(`(ch.${c.chapter})`)}`
                    );
                    if (c.reason) console.log(chalk.dim(`    why: ${c.reason}`));
                    if (c.evidence) console.log(chalk.dim(`    evidence: "${c.evidence}"`));
                }
                break;
            }
            case "accept":
            case "reject": {
                for (const id of rest.map(Number)) {
                    const c = store.getChange(id);
                    if (!c || c.status !== "pending") throw new Error(`no pending change #${id}`);
                    if (sub === "accept") {
                        if (c.field === "target") store.updateTerm(c.termId, { target: c.newValue });
                        else store.setGender(c.termId, c.chapter ?? 1, c.newValue as Gender);
                    }
                    store.setChangeStatus(id, sub === "accept" ? "applied" : "rejected");
                    console.log(`${sub}ed #${id}: ${c.source} ${c.field} → ${c.newValue}`);
                }
                break;
            }
            case "set": {
                const existing = store.findTerm(arg);
                const type = opts.type as TermType | undefined;
                if (type && !TERM_TYPES.includes(type)) throw new Error(`type must be one of ${TERM_TYPES.join(", ")}`);
                const gender = opts.gender as Gender | undefined;
                if (gender && !["m", "f", "unknown"].includes(gender)) throw new Error("gender must be m, f or unknown");
                let term: Term;
                if (!existing) {
                    if (!opts.target) throw new Error("new term needs --target");
                    term = store.insertTerm({ source: arg, target: opts.target, type: type ?? "other", note: opts.note, firstChapter: null });
                } else {
                    store.updateTerm(existing.id, { target: opts.target, type, note: opts.note });
                    term = existing;
                }
                if (gender) store.setGender(term.id, opts.from ?? 1, gender);
                console.log(formatTerm(store.getTerm(term.id)!));
                break;
            }
            case "lock":
            case "unlock":
                store.updateTerm(need(arg).id, { locked: sub === "lock" });
                console.log(formatTerm(need(arg)));
                break;
            case "delete":
                store.deleteTerm(need(arg).id);
                console.log(`deleted ${arg}`);
                break;
            default:
                console.log(GLOSSARY_HELP);
        }
    } finally {
        store.close();
    }
}

export const GLOSSARY_HELP = `glossary commands:
  import [meta.json]           import an old flat memory file
  export [file.json]           dump the glossary as JSON
  list [query] [--type T]      list / search terms
  show <term>                  term details and its change history
  changes [--all]              pending changes (translation / gender) to review
  accept <id...> | reject <id...>
  set <term> [--target X] [--type T] [--gender m|f|unknown --from N] [--note X]
  lock <term> | unlock <term>  locked terms are never changed by the model
  delete <term>`;
