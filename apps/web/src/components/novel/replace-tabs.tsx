"use client";

import { useState } from "react";
import { MessagesSquare, Replace } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AssistantChat } from "./assistant-chat";
import { ReplacePanel } from "./replace-panel";

export function ReplaceTabs({ novelId, chapters, mode, task }: { novelId: number; chapters: number; mode: "replace" | "assistant"; task?: string }) {
    const [tab, setTab] = useState<string>(mode);
    return (
        <Tabs value={tab} onValueChange={setTab} className="gap-4">
            <TabsList>
                <TabsTrigger value="replace">
                    <Replace />
                    Find and replace
                </TabsTrigger>
                <TabsTrigger value="assistant">
                    <MessagesSquare />
                    Assistant
                </TabsTrigger>
            </TabsList>
            <TabsContent value="replace" keepMounted>
                <ReplacePanel novelId={novelId} chapters={chapters} />
            </TabsContent>
            {/* kept mounted: the conversation lives only in this page */}
            <TabsContent value="assistant" keepMounted>
                <AssistantChat novelId={novelId} initialTask={task} />
            </TabsContent>
        </Tabs>
    );
}
