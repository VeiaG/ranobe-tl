import Anthropic from "@anthropic-ai/sdk";
import type { TranslationConfig } from "../config";
import type { Usage } from "../pipeline/translator";
import { wellFormed } from "../pipeline/text";

export type BatchParams = Anthropic.Messages.MessageCreateParamsNonStreaming;
export type BatchResult = Anthropic.Messages.Batches.MessageBatchIndividualResponse;
export type MessageBatch = Anthropic.Messages.Batches.MessageBatch;

/**
 * Message Batches client. `baseURL` is the key's custom endpoint as the AI SDK takes it
 * (".../v1"); the Anthropic SDK adds "/v1" itself.
 */
export function batchClient(apiKey: string, baseURL?: string | null): Anthropic {
    return new Anthropic({ apiKey, baseURL: baseURL ? baseURL.replace(/\/v1\/?$/, "") : undefined, maxRetries: 5 });
}

/** One request of a batch. The system prompt is marked for caching (best effort inside a batch). */
export function batchParams(opts: { model: string; system: string; prompt: string; maxTokens: number; effort?: TranslationConfig["effort"] }): BatchParams {
    return {
        model: opts.model,
        max_tokens: opts.maxTokens,
        system: [{ type: "text", text: wellFormed(opts.system), cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: wellFormed(opts.prompt) }],
        ...(opts.effort ? { output_config: { effort: opts.effort } } : {}),
    };
}

/** The text of a reply (thinking blocks left out). */
export function messageText(message: Anthropic.Messages.Message): string {
    return message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
}

/** Tokens of a reply; `input` includes the cached part, as everywhere in this app. */
export function messageUsage(message: Anthropic.Messages.Message): Usage {
    const u = message.usage;
    const cached = u.cache_read_input_tokens ?? 0;
    return { input: u.input_tokens + cached + (u.cache_creation_input_tokens ?? 0), cachedInput: cached, output: u.output_tokens };
}

/** Why a reply cannot be used as it is, or undefined. */
export function stopProblem(message: Anthropic.Messages.Message): string | undefined {
    if (message.stop_reason === "max_tokens") return "output hit the token limit";
    if (message.stop_reason === "refusal") return "the model declined the request";
    return undefined;
}
