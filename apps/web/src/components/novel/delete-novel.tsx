"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Trash2 } from "lucide-react";
import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { deleteNovel } from "@/server/actions/novels";

export function DeleteNovel({ novelId, title }: { novelId: number; title: string }) {
    const [confirm, setConfirm] = useState("");
    const [pending, start] = useTransition();
    return (
        <section className="flex flex-col gap-4 rounded-xl border border-destructive/30 p-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
                <h2 className="font-medium">Delete this novel</h2>
                <p className="text-sm text-muted-foreground">Chapters, translations, the glossary and its history are deleted for good.</p>
            </div>
            <AlertDialog>
                <AlertDialogTrigger render={<Button variant="outline" className="text-destructive hover:text-destructive" />}>
                        <Trash2 />
                        Delete novel
                    </AlertDialogTrigger>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete “{title}”?</AlertDialogTitle>
                        <AlertDialogDescription>Type the title to confirm. Export the translations first if you want to keep them.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={title} />
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <Button
                            variant="destructive"
                            disabled={confirm.trim() !== title.trim() || pending}
                            onClick={() =>
                                start(async () => {
                                    const res = await deleteNovel(novelId);
                                    if (res && !res.ok) toast.error(res.error);
                                })
                            }
                        >
                            {pending && <Loader2 className="animate-spin" />}
                            Delete
                        </Button>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </section>
    );
}
