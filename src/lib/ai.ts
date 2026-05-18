import { ParseMode } from '@grammyjs/types';
import { markdownToHtml, type AiResponse, type Tool, type Task } from '@codebam/shared';
import { runWithTools as cfRunWithTools } from '@cloudflare/ai-utils';

/**
 * Robustly extract text from various AI response formats.
 */
export function extractText(obj: string | AiResponse | any): string {
	if (typeof obj === 'string') {
		return obj;
	}
	if (typeof obj !== 'object' || obj === null) {
		return '';
	}

	const response = obj as any;

	if (typeof response.response === 'string') return response.response;
	if (typeof response.text === 'string') return response.text;
	if (typeof response.content === 'string') return response.content;
	if (typeof response.delta === 'string') return response.delta;
	if (typeof response.reasoning === 'string') return response.reasoning;
	if (typeof response.reasoning_content === 'string') return response.reasoning_content;

	if (response.choices && Array.isArray(response.choices) && response.choices.length > 0)
		return extractText(response.choices[0]);
	if (response.message) return extractText(response.message);
	if (response.delta) return extractText(response.delta);
	if (response.tool_calls) return ''; // Skip tool calls in extraction
	if (response.candidates && Array.isArray(response.candidates) && response.candidates.length > 0)
		return extractText(response.candidates[0]);
	if (response.content) return extractText(response.content);
	if (response.parts && Array.isArray(response.parts) && response.parts.length > 0) {
		for (const part of response.parts) {
			if (part.text) return part.text;
		}
	}

	return '';
}

/**
 * Custom runner that supports tool calls across different AI models.
 */
export async function customRunWithTools(
	ai: any,
	model: string,
	input: { messages: any[]; tools?: Tool[] },
	config: { streamFinalResponse: boolean }
): Promise<AiResponse | ReadableStream> {
	console.log(`[customRunWithTools] Model: ${model}, Tools: ${input.tools?.length || 0}, Stream: ${config.streamFinalResponse}`);

	// Map our tools to the format expected by ai-utils
	const tools = (input.tools || []).map((t: Tool) => ({
		name: t.name,
		description: t.description,
		parameters: t.parameters,
		run: t.function
	}));

	try {
		// Use the official Cloudflare utility which handles multi-turn and platform specific logic
		// This handles Gemini's thoughtSignature and role mapping automatically
		const response = await cfRunWithTools(ai, model, {
			messages: input.messages,
			tools,
			streamFinalResponse: config.streamFinalResponse,
			maxRecursiveToolRuns: 5
		});

		// If it's a stream, return it directly
		if (response instanceof ReadableStream) {
			console.log('[customRunWithTools] Returning streaming response from ai-utils.');
			return response;
		}

		// Otherwise, wrap it in our AiResponse interface
		console.log('[customRunWithTools] Returning direct response from ai-utils.');
		return response as unknown as AiResponse;
	} catch (e: any) {
		console.error(`[customRunWithTools] ai-utils failed for model ${model}:`, e);
		throw e;
	}
}

export async function sendMessageDraft(token: string, data: any) {
	try {
		await fetch(`https://api.telegram.org/bot${token}/sendMessageDraft`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(data),
		});
	} catch (e) {
		console.log('Error sending draft update:', e);
	}
}

/**
 * Get AI stream for a model.
 */
export async function* getAiStream(ai: any, model: string, messages: any[], tools: Tool[] = []) {
	const response = await customRunWithTools(ai, model, { messages, tools }, { streamFinalResponse: true });

	if (response instanceof ReadableStream) {
		const reader = response.getReader();
		const decoder = new TextDecoder();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const chunk = decoder.decode(value);
			const lines = chunk.split('\n');
			for (const line of lines) {
				if (line.startsWith('data: ')) {
					const data = line.substring(6);
					if (data === '[DONE]') break;
					try {
						const parsed = JSON.parse(data);
						const text = extractText(parsed);
						if (text) yield text;
					} catch {
						// Ignore malformed JSON chunks
					}
				}
			}
		}
	} else {
		console.log('[getAiStream] aiResponse is not a stream, yielding extractText(aiResponse)');
		yield extractText(response);
	}
}

/**
 * Stream AI response to Telegram, with periodic updates to avoid rate limits.
 */
export async function streamAiResponseToTelegram(
	ctx: any,
	ai: any,
	modelId: string,
	messages: any[],
	task: Task,
	tools: Tool[] = []
): Promise<string> {
	const token = task.telegramToken || task.token || ctx.env.SECRET_TELEGRAM_API_TOKEN;
	const draftId = task.updateId || Date.now();

	console.log(`[streamAiResponseToTelegram] Starting for task: ${task.type}, updateType: ${task.updateType}, model: ${modelId}`);

	if (task.updateType !== 'guest_message' && task.updateType !== 'business_message') {
		await sendMessageDraft(token, {
			chat_id: task.chatId,
			text: 'Thinking...',
			parse_mode: 'HTML',
			message_thread_id: task.threadId,
			business_connection_id: task.businessConnectionId,
			draft_id: draftId,
		});
	}

	let streamContent = '';

	if (ctx.replyWithStream && task.updateType !== 'guest_message' && task.updateType !== 'business_message') {
		console.log('[streamAiResponseToTelegram] Using ctx.replyWithStream');
		// Use the grammy stream plugin if available on context
		const iterator = getAiStream(ai, modelId, messages, tools);
		let lastDraftUpdate = Date.now();

		async function* streamWithMetadata() {
			for await (const chunk of iterator) {
				streamContent += chunk;
				yield chunk;

				if (Date.now() - lastDraftUpdate > 2000) {
					await sendMessageDraft(token, {
						chat_id: task.chatId,
						text: await markdownToHtml(streamContent + '...'),
						parse_mode: 'HTML',
						message_thread_id: task.threadId,
						business_connection_id: task.businessConnectionId,
						draft_id: draftId,
					});
					lastDraftUpdate = Date.now();
				}
			}
		}
		await ctx.replyWithStream(streamWithMetadata(), {
			parse_mode: 'HTML',
			message_thread_id: task.threadId,
			business_connection_id: task.businessConnectionId,
			reply_to_message_id: task.messageId,
		});

		await sendMessageDraft(token, {
			chat_id: task.chatId,
			text: await markdownToHtml(streamContent),
			parse_mode: 'HTML',
			message_thread_id: task.threadId,
			business_connection_id: task.businessConnectionId,
			draft_id: draftId,
			finish: true,
		});
	} else {
		console.log('[streamAiResponseToTelegram] Using getAiStream fallback');
		const lastUpdate = { time: Date.now() };
		try {
			for await (const chunk of getAiStream(ai, modelId, messages, tools)) {
				streamContent += chunk;
				if (
					task.updateType !== 'guest_message' &&
					task.updateType !== 'business_message' &&
					Date.now() - lastUpdate.time > 2000 &&
					streamContent.trim()
				) {
					await sendMessageDraft(token, {
						chat_id: task.chatId,
						text: await markdownToHtml(streamContent + '...'),
						parse_mode: 'HTML',
						message_thread_id: task.threadId,
						business_connection_id: task.businessConnectionId,
						draft_id: draftId,
					});
					lastUpdate.time = Date.now();
				}
			}
		} catch (e) {
			console.error('[streamAiResponseToTelegram] Error during AI streaming:', e);
		}

		console.log(`[streamAiResponseToTelegram] Stream finished. Content length: ${streamContent.length}`);

		if (streamContent.trim()) {
			if (task.updateType !== 'guest_message' && task.updateType !== 'business_message') {
				console.log('[streamAiResponseToTelegram] Sending final sendMessageDraft and sendMessage');
				await sendMessageDraft(token, {
					chat_id: task.chatId,
					text: await markdownToHtml(streamContent),
					parse_mode: 'HTML',
					message_thread_id: task.threadId,
					business_connection_id: task.businessConnectionId,
					draft_id: draftId,
					finish: true,
				});
				await ctx.api
					.sendMessage(task.chatId, await markdownToHtml(streamContent), {
						parse_mode: 'HTML',
						message_thread_id: task.threadId,
						business_connection_id: task.businessConnectionId,
						reply_to_message_id: task.messageId,
					})
					.catch((e: any) => console.log('Error sending final message:', e));
			}
		}
	}
	return streamContent;
}
