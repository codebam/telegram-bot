import type { Api } from 'grammy';
import type { MessageDraftPiece, StreamContextExtension } from '@grammyjs/stream';
import {
	markdownToHtml,
	AVAILABLE_MODELS,
	type AiResponse,
	type ChatMessage,
	type GeminiPart,
	type NormalizedToolCall,
	type RawToolCall,
	type Task,
	type Tool,
} from '@codebam/shared';

const THINK_TAGS = ['think', 'thinking', 'reasoning', 'reflection', 'thought', 'analysis'];
const THINK_BLOCK_RE = new RegExp(
	`<(?:${THINK_TAGS.join('|')})(?:\\s[^>]*)?>[\\s\\S]*?</(?:${THINK_TAGS.join('|')})>`,
	'gi'
);
const THINK_OPEN_ONLY_RE = new RegExp(`<(?:${THINK_TAGS.join('|')})(?:\\s[^>]*)?>[\\s\\S]*$`, 'i');

/**
 * Strip <think>/<reasoning>/etc. blocks from a complete string. Also drops
 * an unterminated opening block (when the model never closes it) and trims
 * leading whitespace left behind.
 */
export function stripThinking(text: string): string {
	if (!text) return text;
	let out = text.replace(THINK_BLOCK_RE, '');
	out = out.replace(THINK_OPEN_ONLY_RE, '');
	return out.replace(/^\s+/, '');
}

/**
 * Stream-aware filter: feed chunks of generated text in order and receive
 * the same text with think-tag content removed, tolerating tags split across
 * chunks.
 */
export function createThinkFilter() {
	let inside = false;
	let buffer = '';
	let emittedAny = false;
	const flush = (chunk: string) => {
		const out = emittedAny ? chunk : chunk.replace(/^\s+/, '');
		if (out) emittedAny = true;
		return out;
	};
	return {
		push(chunk: string): string {
			let result = '';
			let current = buffer + chunk;
			buffer = '';

			while (current.length > 0) {
				if (inside) {
					const closeMatch = current.match(/<\/([a-z]+)>/i);
					if (closeMatch && THINK_TAGS.includes(closeMatch[1].toLowerCase())) {
						const closeIdx = closeMatch.index!;
						current = current.slice(closeIdx + closeMatch[0].length);
						inside = false;
					} else {
						return '';
					}
				} else {
					const openMatch = current.match(/<([a-z]+)(?:\s[^>]*)?>/i);
					if (openMatch && THINK_TAGS.includes(openMatch[1].toLowerCase())) {
						const openIdx = openMatch.index!;
						result += flush(current.slice(0, openIdx));
						current = current.slice(openIdx + openMatch[0].length);
						inside = true;
					} else {
						const lastLt = current.lastIndexOf('<');
						if (lastLt !== -1 && lastLt > current.length - 20) {
							const partial = current.slice(lastLt);
							const isPotential = THINK_TAGS.some(tag => {
								const openTag = `<${tag}`;
								const closeTag = `</${tag}`;
								return openTag.startsWith(partial) || closeTag.startsWith(partial);
							});
							if (isPotential) {
								result += flush(current.slice(0, lastLt));
								buffer = partial;
								return result;
							}
						}
						result += flush(current);
						return result;
					}
				}
			}
			return result;
		},
		end(): string {
			if (inside) {
				inside = false;
				buffer = '';
				return '';
			}
			const tail = buffer;
			buffer = '';
			return flush(tail);
		}
	};
}

type ExtractInput = string | AiResponse | Record<string, unknown> | null | undefined;

/**
 * Robustly extract text from various AI response formats.
 */
export function extractText(obj: ExtractInput): string {
	if (typeof obj === 'string') {
		return obj;
	}
	if (typeof obj !== 'object' || obj === null) {
		return '';
	}

	const response = obj as Record<string, unknown>;

	if (typeof response.response === 'string') return response.response;
	if (typeof response.text === 'string') return response.text;
	if (typeof response.content === 'string') return response.content;
	
	// Handle delta objects (OpenAI-style streaming)
	if (typeof response.delta === 'object' && response.delta !== null) {
		const delta = response.delta as any;
		if (typeof delta.content === 'string') return delta.content;
		// Skip reasoning_content and thought in the final extraction to prevent leaks
		if (typeof delta.text === 'string') return delta.text;
	}
	if (typeof response.delta === 'string') return response.delta;

	// Recursively search in common nested fields
	if (Array.isArray(response.choices) && response.choices.length > 0)
		return extractText(response.choices[0] as ExtractInput);
	if (response.message) return extractText(response.message as ExtractInput);
	if (response.delta) return extractText(response.delta as ExtractInput);
	if (response.tool_calls) return ''; // Skip tool calls in extraction
	if (Array.isArray(response.candidates) && response.candidates.length > 0)
		return extractText(response.candidates[0] as ExtractInput);
	if (response.content) return extractText(response.content as ExtractInput);
	
	// Gemini parts
	if (Array.isArray(response.parts) && response.parts.length > 0) {
		let text = '';
		for (const part of response.parts as GeminiPart[]) {
			if (part.thought) continue; // Gemini thinking parts
			if (part.text) text += part.text;
		}
		return text;
	}

	// Any other string field as a fallback, but excluding known meta/thinking fields
	for (const key of Object.keys(response)) {
		if (['id', 'model', 'object', 'created', 'usage', 'index', 'finish_reason', 'reasoning_content', 'thought'].includes(key)) continue;
		if (typeof response[key] === 'string' && response[key]) return response[key] as string;
	}

	return '';
}

interface AiRunner {
	run(model: string, inputs: Record<string, unknown>): Promise<AiResponse | ReadableStream | Response>;
}

function createMockStream(text: string): ReadableStream {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			const payload = `data: ${JSON.stringify({ response: text })}\n\ndata: [DONE]\n\n`;
			controller.enqueue(encoder.encode(payload));
			controller.close();
		}
	});
}

/**
 * Custom runner that supports tool calls across different AI models.
 */
export async function customRunWithTools(
	ai: AiRunner,
	model: string,
	input: { messages: ChatMessage[]; tools?: Tool[] },
	config: { streamFinalResponse: boolean }
): Promise<AiResponse | ReadableStream> {
	console.log(`[customRunWithTools] Model: ${model}, Tools: ${input.tools?.length || 0}, Stream: ${config.streamFinalResponse}`);
	
	const modelConfig = Object.values(AVAILABLE_MODELS).find((cfg) => cfg.id === model);
	const supportsVision = modelConfig?.supportsVision || false;
	const isGemini = model.includes('google/gemini');

	const messages: ChatMessage[] = input.messages.map((m) => {
		if (m.geminiParts) {
			if (!supportsVision) {
				const textParts = m.geminiParts.filter(p => !p.inlineData);
				const firstText = textParts.find(p => p.text)?.text || m.content;
				return {
					...m,
					content: firstText,
					geminiParts: undefined
				};
			} else if (!isGemini) {
				const hasImage = m.geminiParts.some(p => p.inlineData);
				if (hasImage) {
					const contentParts: any[] = [];
					const textPart = m.geminiParts.find(p => p.text);
					if (textPart && textPart.text) {
						contentParts.push({ type: 'text', text: textPart.text });
					} else if (m.content) {
						contentParts.push({ type: 'text', text: m.content });
					}

					for (const part of m.geminiParts) {
						if (part.inlineData) {
							contentParts.push({
								type: 'image_url',
								image_url: {
									url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`
								}
							});
						}
					}
					return {
						...m,
						content: contentParts as any,
						geminiParts: undefined
					};
				}
			}
		}
		return { ...m };
	});

	const tools = input.tools || [];

	const cfTools = tools.map((t) => ({
		name: t.name,
		description: t.description,
		parameters: t.parameters,
	}));

	const runModel = async (msgs: ChatMessage[], stream: boolean, omitTools = false) => {
		console.log(`[customRunWithTools] runModel starting. Stream: ${stream}, Model: ${model}, OmitTools: ${omitTools}`);
		console.log(`[customRunWithTools] msgs passed to Cloudflare:`, JSON.stringify(msgs));
		try {
			if (isGemini) {
				const systemMessage = msgs.find((m) => m.role === 'system');
				const otherMessages = msgs.filter((m) => m.role !== 'system');
				const geminiInput: Record<string, unknown> = {
					contents: otherMessages.map((m) => {
						// For Gemini, we must preserve the exact parts array from previous turns
						if (m.geminiParts) {
							return {
								role: m.role === 'assistant' ? 'model' : 'user',
								parts: m.geminiParts,
							};
						}

						const role = m.role === 'assistant' ? 'model' : 'user';
						const parts: GeminiPart[] = [];
						if (m.content) parts.push({ text: m.content });
						return { role, parts };
					}),
					tools: (!omitTools && cfTools.length > 0) ? [{ functionDeclarations: cfTools }] : undefined,
					stream,
				};
				if (systemMessage?.content) {
					geminiInput.system_instruction = {
						parts: [{ text: systemMessage.content }],
					};
				}
				return await ai.run(model, geminiInput);
			}

			const options: Record<string, unknown> = {
				messages: msgs.map((m) => {
					// Ensure content is not null (use empty string if empty/null)
					const cleanMessage: any = { ...m };
					if (cleanMessage.role === 'assistant' && cleanMessage.tool_calls && !cleanMessage.content) {
						cleanMessage.content = null;
					} else if (cleanMessage.content === null || cleanMessage.content === undefined) {
						cleanMessage.content = '';
					}
					// Remove internal geminiParts before sending to CF
					delete cleanMessage.geminiParts;
					return cleanMessage;
				}),
				tools: (!omitTools && cfTools.length > 0) ? cfTools.map((t) => ({ type: 'function', function: t })) : undefined,
				tool_choice: (!omitTools && cfTools.length > 0) ? 'auto' : undefined,
				stream,
			};

			console.log(`[customRunWithTools] Calling ai.run with options:`, JSON.stringify({
				...options,
				messages: (options.messages as any[]).map(m => ({ role: m.role, contentLength: m.content?.length, keys: Object.keys(m) }))
			}));

			const result = await ai.run(model, options);
			const isStream = result && typeof (result as any).getReader === 'function';
			console.log(`[customRunWithTools] ai.run returned. Type: ${typeof result}, isStream: ${isStream}, Keys: ${result && typeof result === 'object' ? Object.keys(result).join(', ') : 'none'}`);
			
			if (stream && !isStream) {
				if (result && typeof result === 'object' && 'body' in result && result.body && typeof (result.body as any).getReader === 'function') {
					return result.body;
				}
			}
			return result;
		} catch (e) {
			console.error(`[customRunWithTools] ai.run failed for model ${model}:`, e);
			throw e;
		}
	};

	let turn = 0;
	while (turn < 5) {
		const isFinalTurn = turn > 0 || cfTools.length === 0;
		const shouldStream = isFinalTurn ? config.streamFinalResponse : false;
		const response = await runModel(messages, shouldStream, turn > 0);

		if (shouldStream || (response && typeof (response as any).getReader === 'function')) {
			return response as ReadableStream;
		}

		const aiRes = response as AiResponse;
		let toolCalls: RawToolCall[] = [];
		let geminiParts: GeminiPart[] = [];

		if (aiRes?.tool_calls) {
			toolCalls = [...aiRes.tool_calls];
		} else if (aiRes?.choices?.[0]?.message?.tool_calls) {
			toolCalls = [...aiRes.choices[0].message.tool_calls];
		} else if (isGemini && aiRes?.candidates?.[0]?.content?.parts) {
			geminiParts = aiRes.candidates[0].content.parts;
			// Extract Gemini function calls
			for (const part of geminiParts) {
				if (part.functionCall) {
					toolCalls.push({
						id: `call_${Math.random().toString(36).substring(2, 9)}`,
						type: 'function',
						function: {
							name: part.functionCall.name,
							arguments: part.functionCall.args,
						},
					});
				}
			}
		}

		const responseText = extractText(aiRes);

		if (toolCalls.length > 0) {
			const normalizedToolCalls: NormalizedToolCall[] = toolCalls.map((call, index) => {
				let name = call.name || call.function?.name || '';
				if (name.startsWith('functions.')) {
					name = name.substring(10);
				}
				let args = call.arguments ?? call.function?.arguments ?? '';				if (typeof args !== 'string') {
					try {
						args = JSON.stringify(args);
					} catch {
						args = '{}';
					}
				}
				return {
					id: call.id || `call_${Math.random().toString(36).substring(2, 9)}_${index}`,
					type: 'function',
					function: { name, arguments: args },
				};
			});

			const assistantMessage: any = {
				role: 'assistant',
				content: responseText || null,
				tool_calls: normalizedToolCalls,
			};
			if (isGemini) {
				assistantMessage.geminiParts = geminiParts;
			}
			messages.push(assistantMessage);

			for (const call of normalizedToolCalls) {
				const toolName = call.function.name;
				const toolId = call.id;
				const toolArgsString = call.function.arguments;
				const tool = tools.find((t) => t.name === toolName);

				if (tool && tool.function) {
					try {
						let parsedArgs: unknown;
						try {
							parsedArgs = JSON.parse(toolArgsString);
						} catch {
							parsedArgs = toolArgsString;
						}
						const result = await tool.function(parsedArgs);
						const content = typeof result === 'string' ? result : JSON.stringify(result);

						const toolMessage: ChatMessage = { role: 'tool', tool_call_id: toolId, name: toolName, content };
						if (isGemini) {
							toolMessage.geminiParts = [
								{
									functionResponse: {
										name: toolName,
										response: { content },
									},
								},
							];
						}
						messages.push(toolMessage);
					} catch (e) {
						console.error(`[customRunWithTools] Tool execution failed: ${toolName}`, e);
						const content = `Error: ${String(e)}`;
						const toolMessage: ChatMessage = { role: 'tool', tool_call_id: toolId, name: toolName, content };
						if (isGemini) {
							toolMessage.geminiParts = [
								{
									functionResponse: {
										name: toolName,
										response: { content },
									},
								},
							];
						}
						messages.push(toolMessage);
					}
				} else {
					const content = 'Tool not found';
					const toolMessage: ChatMessage = { role: 'tool', tool_call_id: toolId, name: toolName, content };
					if (isGemini) {
						toolMessage.geminiParts = [
							{
								functionResponse: {
									name: toolName,
									response: { content },
								},
							},
						];
					}
					messages.push(toolMessage);
				}
			}
		} else {
			if (config.streamFinalResponse) {
				console.log(`[customRunWithTools] Creating mock stream from successful response. Text length: ${responseText.length}`);
				return createMockStream(responseText);
			}
			return aiRes;
		}
		turn++;
	}

	console.log('[customRunWithTools] Maximum turns reached.');
	const finalResponse = await runModel(messages, config.streamFinalResponse, true);
	if (config.streamFinalResponse && finalResponse instanceof ReadableStream) {
		return finalResponse;
	}
	const finalText = extractText(finalResponse as AiResponse);
	if (config.streamFinalResponse && finalText) {
		return createMockStream(finalText);
	}
	return finalResponse as AiResponse;
}

export async function sendMessageDraft(token: string, data: Record<string, unknown>) {
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
async function* runStream(ai: AiRunner, model: string, messages: ChatMessage[], tools: Tool[] = [], onStatusUpdate?: (status: 'Thinking' | 'Reasoning') => void): AsyncGenerator<string, void, unknown> {
	console.log(`[runStream] Starting stream for model: ${model}`);
	const response = await customRunWithTools(ai, model, { messages, tools }, { streamFinalResponse: true });
	const filter = createThinkFilter();

	if (response && typeof (response as any).getReader === 'function') {
		const reader = (response as ReadableStream).getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		let chunkCount = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					console.log(`[runStream] Stream closed after ${chunkCount} chunks.`);
					break;
				}
				chunkCount++;
				const chunkStr = decoder.decode(value, { stream: true });
				buffer += chunkStr;
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed) continue;
					if (trimmed.startsWith('data: ')) {
						const data = trimmed.substring(6);
						if (data === '[DONE]') break;
						try {
							const parsed = JSON.parse(data);
							
							// Check for reasoning signals in the raw JSON
							const delta = (parsed.choices?.[0] as any)?.delta;
							if (delta && (delta.reasoning_content || delta.thought)) {
								onStatusUpdate?.('Reasoning');
							}

							const text = extractText(parsed);
							if (chunkCount <= 10) {
								const keys = Object.keys(parsed).join(', ');
								const hasContent = !!text;
								console.log(`[runStream] Chunk ${chunkCount} keys: ${keys}. hasText: ${hasContent}`);
								if (!hasContent && chunkCount <= 3) {
									console.log(`[runStream] Chunk ${chunkCount} raw: ${JSON.stringify(parsed)}`);
								}
							}
							if (text) {
								const filtered = filter.push(text);
								if (filtered) yield filtered;
							}
						} catch (e) {
							console.log(`[runStream] Failed to parse JSON from line: "${trimmed.slice(0, 100)}..."`);
						}
					} else {
						// Attempt to parse line as raw JSON if it doesn't have 'data: ' prefix
						try {
							const parsed = JSON.parse(trimmed);
							
							// Check for reasoning signals in the raw JSON
							const delta = (parsed.choices?.[0] as any)?.delta;
							if (delta && (delta.reasoning_content || delta.thought)) {
								onStatusUpdate?.('Reasoning');
							}

							const text = extractText(parsed);
							if (chunkCount <= 10) {
								const keys = Object.keys(parsed).join(', ');
								const hasContent = !!text;
								console.log(`[runStream] Raw JSON chunk ${chunkCount} keys: ${keys}. hasText: ${hasContent}`);
							}
							if (text) {
								const filtered = filter.push(text);
								if (filtered) yield filtered;
							}
						} catch {
							// Not JSON, ignore
						}
					}
				}
			}
		} finally {
			try {
				reader.releaseLock();
			} catch {
				// Safety release
			}
		}
		const tail = filter.end();
		if (tail) yield tail;
	} else {
		console.log(`[runStream] Response is not a stream. Type: ${typeof response}`);
		yield stripThinking(extractText(response as AiResponse));
	}
}

/**
 * Get AI stream for a model with automatic Gemini fallback.
 */
export async function* getAiStream(ai: AiRunner, model: string, messages: ChatMessage[], tools: Tool[] = [], onStatusUpdate?: (status: 'Thinking' | 'Reasoning') => void): AsyncGenerator<string, void, unknown> {
	const fallbackModel = 'google/gemini-3.1-flash-lite';
	if (model === fallbackModel) {
		yield* runStream(ai, model, messages, tools, onStatusUpdate);
		return;
	}

	try {
		console.log(`[getAiStream] Attempting primary model: ${model}`);
		const iterator = runStream(ai, model, messages, tools, onStatusUpdate)[Symbol.asyncIterator]();

		// Set to 10 seconds to allow time for tool execution and multi-turn inference
		const timeoutPromise = new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error('TTFT_TIMEOUT')), 10000)
		);

		const firstResult = await Promise.race([
			iterator.next(),
			timeoutPromise
		]);

		if (firstResult.done) {
			return;
		}

		yield firstResult.value;

		while (true) {
			const res = await iterator.next();
			if (res.done) {
				break;
			}
			yield res.value;
		}
	} catch (err) {
		console.error(`[getAiStream] Primary model ${model} timed out or failed. Error:`, err);
		console.log(`[getAiStream] Triggering silent fallback to ${fallbackModel}...`);
		yield* runStream(ai, fallbackModel, messages, tools);
	}
}

export interface StreamCtx {
	env: { SECRET_TELEGRAM_API_TOKEN: string };
	api: Api;
	replyWithStream?: StreamContextExtension['replyWithStream'];
}

/**
 * Stream AI response to Telegram, with periodic updates to avoid rate limits.
 */
export async function streamAiResponseToTelegram(
	ctx: StreamCtx,
	ai: AiRunner,
	modelId: string,
	messages: ChatMessage[],
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
	let hasSeenReasoning = false;

	if (ctx.replyWithStream && task.updateType !== 'guest_message' && task.updateType !== 'business_message') {
		console.log('[streamAiResponseToTelegram] Using ctx.replyWithStream');
		const iterator = getAiStream(ai, modelId, messages, tools, (status) => {
			if (status === 'Reasoning') hasSeenReasoning = true;
		});
		let lastDraftUpdate = Date.now();

		async function* streamWithMetadata(): AsyncIterable<MessageDraftPiece> {
			for await (const chunk of iterator) {
				streamContent += chunk;
				yield chunk as MessageDraftPiece;

				const now = Date.now();
				if (now - lastDraftUpdate > 2000) {
					const text = streamContent 
						? await markdownToHtml(streamContent + '...') 
						: (hasSeenReasoning ? 'Reasoning...' : 'Thinking...');
						
					await sendMessageDraft(token, {
						chat_id: task.chatId,
						text,
						parse_mode: 'HTML',
						message_thread_id: task.threadId,
						business_connection_id: task.businessConnectionId,
						draft_id: draftId,
					});
					lastDraftUpdate = now;
				}
			}
		}
		await ctx.replyWithStream(
			streamWithMetadata(),
			{
				parse_mode: 'HTML',
				message_thread_id: task.threadId,
			},
			{
				parse_mode: 'HTML',
				message_thread_id: task.threadId,
				business_connection_id: task.businessConnectionId,
				reply_parameters: task.messageId ? { message_id: task.messageId } : undefined,
			}
		);

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

		// Safely truncate streamContent to avoid exceeding Telegram's 4096 character limit
		const TEXT_LIMIT = 3800;
		if (streamContent.length > TEXT_LIMIT) {
			console.log(`[streamAiResponseToTelegram] Content length (${streamContent.length}) exceeds limit. Truncating...`);
			streamContent = streamContent.slice(0, TEXT_LIMIT) + '\n\n[Truncated due to Telegram length limit]';
		}

		if (streamContent.trim()) {
			if (task.updateType === 'guest_message') {
				if (task.guestQueryId) {
					console.log('[streamAiResponseToTelegram] Answering guest_message via answerGuestQuery');
					const messageText = await markdownToHtml(streamContent);
					await ctx.api
						.answerGuestQuery(task.guestQueryId, {
							type: 'article',
							id: crypto.randomUUID(),
							title: streamContent.slice(0, 64),
							input_message_content: {
								message_text: messageText,
								parse_mode: 'HTML',
							},
						})
						.catch((e: unknown) => console.log('Error answering guest query:', e));
				} else {
					console.log('[streamAiResponseToTelegram] guest_message has no guestQueryId, cannot answer');
				}
			} else if (task.updateType === 'business_message') {
				console.log('[streamAiResponseToTelegram] Sending final sendMessage for business_message');
				await ctx.api
					.sendMessage(task.chatId!, await markdownToHtml(streamContent), {
						parse_mode: 'HTML',
						message_thread_id: task.threadId,
						business_connection_id: task.businessConnectionId,
						reply_to_message_id: task.messageId,
					})
					.catch((e: unknown) => console.log('Error sending final business message:', e));
			} else {
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
					.sendMessage(task.chatId!, await markdownToHtml(streamContent), {
						parse_mode: 'HTML',
						message_thread_id: task.threadId,
						business_connection_id: task.businessConnectionId,
						reply_to_message_id: task.messageId,
					})
					.catch((e: unknown) => console.log('Error sending final message:', e));
			}
		}
	}
	return streamContent;
}
