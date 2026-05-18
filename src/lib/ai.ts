import { ParseMode } from '@grammyjs/types';
import { markdownToHtml, type AiResponse, type Tool, type Task } from '@codebam/shared';

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
	if (response.parts && Array.isArray(response.parts) && response.parts.length > 0)
		return extractText(response.parts[0]);

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
	const messages = [...input.messages];
	const tools = input.tools || [];
	const isGemini = model.includes('google/gemini');

	const cfTools = tools.map((t: Tool) => ({
		type: 'function',
		function: {
			name: t.name,
			description: t.description,
			parameters: t.parameters
		}
	}));

	const runModel = async (msgs: any[], stream: boolean) => {
		console.log(`[customRunWithTools] runModel starting. Stream: ${stream}, Model: ${model}`);
		try {
			if (isGemini) {
				const systemMessage = msgs.find((m) => m.role === 'system');
				const otherMessages = msgs.filter((m) => m.role !== 'system');
				const geminiInput: Record<string, unknown> = {
					contents: otherMessages.map((m) => {
						const parts: any[] = [];
						let role = 'user';
						
						if (m.role === 'assistant') {
							role = 'model';
							if (m.content) parts.push({ text: m.content });
							if (m.tool_calls) {
								for (const call of m.tool_calls) {
									try {
										const args = typeof call.function.arguments === 'string' 
											? JSON.parse(call.function.arguments) 
											: call.function.arguments;
										parts.push({ functionCall: { name: call.function.name, args } });
									} catch (e) {
										console.error('[customRunWithTools] Failed to parse Gemini tool call args:', call.function.arguments, e);
									}
								}
							}
						} else if (m.role === 'tool') {
							role = 'function';
							parts.push({
								functionResponse: {
									name: m.name,
									response: { content: m.content }
								}
							});
						} else {
							role = 'user';
							parts.push({ text: m.content });
						}
						return { role, parts };
					}),
					tools: cfTools.length > 0 ? [{ function_declarations: cfTools.map(t => t.function) }] : undefined,
					stream
				};
				if (systemMessage) {
					geminiInput.system_instruction = {
						parts: [{ text: systemMessage.content as string }]
					};
				}
				console.log('[customRunWithTools] Calling ai.run (Gemini) with input:', JSON.stringify(geminiInput));
				const res = await ai.run(model, geminiInput);
				console.log('[customRunWithTools] ai.run (Gemini) call returned.');
				return res;
			}
			
			const options: any = {
				messages: msgs,
				tools: cfTools.length > 0 ? cfTools : undefined,
				stream,
				parallel_tool_calls: false,
				tool_choice: 'auto'
			};

			console.log(`[customRunWithTools] Calling ai.run (Workers AI) with ${msgs.length} messages and ${cfTools.length} tools...`);
			const res = await ai.run(model, options);
			console.log('[customRunWithTools] ai.run (Workers AI) call returned.');
			return res;
		} catch (e) {
			console.error(`[customRunWithTools] ai.run failed for model ${model}:`, e);
			throw e;
		}
	};

	let turn = 0;
	while (turn < 5) {
		console.log(`[customRunWithTools] Starting turn ${turn + 1}...`);
		
		const shouldStream = turn === 4 || cfTools.length === 0 ? config.streamFinalResponse : false;
		const response = await runModel(messages, shouldStream);
		
		if (shouldStream) {
			console.log('[customRunWithTools] Returning streaming response.');
			return response;
		}

		const aiRes = response as AiResponse;
		let toolCalls: any[] = [];
		if (aiRes?.tool_calls) {
			toolCalls = [...aiRes.tool_calls];
		} else if (aiRes?.choices?.[0]?.message?.tool_calls) {
			toolCalls = [...aiRes.choices[0].message.tool_calls];
		} else if (aiRes?.candidates?.[0]?.content?.parts) {
			// Extract Gemini function calls
			for (const part of aiRes.candidates[0].content.parts as any[]) {
				if (part.functionCall) {
					toolCalls.push({
						id: `call_${Math.random().toString(36).substring(2, 9)}`,
						type: 'function',
						function: {
							name: part.functionCall.name,
							arguments: typeof part.functionCall.args === 'string' 
								? part.functionCall.args 
								: JSON.stringify(part.functionCall.args)
						}
					});
				}
			}
		}

		let responseText = aiRes?.response || aiRes?.choices?.[0]?.message?.content || '';

		if (toolCalls.length > 0) {
			console.log(`[customRunWithTools] Found ${toolCalls.length} tool calls.`);
			const normalizedToolCalls = toolCalls.map((call: any, index: number) => {
				const name = call.name || (call.function && call.function.name);
				let args = call.arguments || (call.function && call.function.arguments);
				if (typeof args !== 'string') {
					try {
						args = JSON.stringify(args);
					} catch {
						args = '{}';
					}
				}
				return {
					id: call.id || `call_${Math.random().toString(36).substring(2, 9)}_${index}`,
					type: 'function',
					function: { name, arguments: args }
				};
			});

			messages.push({
				role: 'assistant',
				content: responseText,
				tool_calls: normalizedToolCalls
			});

			for (const call of normalizedToolCalls) {
				const toolName = call.function.name;
				const toolId = call.id;
				const toolArgsString = call.function.arguments;
				const tool = tools.find((t: Tool) => t.name === toolName);

				if (tool && tool.function) {
					console.log(`[customRunWithTools] Executing tool: ${toolName}`);
					try {
						let parsedArgs;
						try {
							parsedArgs = JSON.parse(toolArgsString);
						} catch {
							parsedArgs = toolArgsString;
						}
						const result = await tool.function(parsedArgs);
						console.log(`[customRunWithTools] Tool ${toolName} execution successful.`);
						messages.push({ role: 'tool', tool_call_id: toolId, name: toolName, content: String(result) });
					} catch (e) {
						console.error(`[customRunWithTools] Tool execution failed: ${toolName}`, e);
						messages.push({ role: 'tool', tool_call_id: toolId, name: toolName, content: String(e) });
					}
				} else {
					messages.push({ role: 'tool', tool_call_id: toolId, name: toolName, content: 'Tool not found' });
				}
			}
		} else {
			console.log('[customRunWithTools] No more tool calls. Finishing...');
			if (config.streamFinalResponse) {
				console.log('[customRunWithTools] Re-running final model call for streaming...');
				return await runModel(messages, true);
			}
			return aiRes;
		}
		turn++;
	}

	console.log('[customRunWithTools] Maximum turns reached.');
	return (await runModel(messages, config.streamFinalResponse)) as AiResponse | ReadableStream;
}

export async function sendMessageDraft(token: string, data: any) {
	try {
		await fetch(`https://api.telegram.org/bot${token}/sendMessageDraft`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(data)
		});
	} catch (e) {
		console.error('sendMessageDraft failed', e);
	}
}

/**
 * Async generator that yields AI response chunks.
 */
export async function* getAiStream(
	ai: any,
	modelId: string,
	messages: any[],
	tools: Tool[] = []
): AsyncGenerator<string> {
	console.log(`[getAiStream] Starting for model: ${modelId}`);
	const aiResponse = await customRunWithTools(
		ai,
		modelId,
		{
			messages,
			tools,
		},
		{ streamFinalResponse: true },
	);

	if (typeof aiResponse === 'object' && aiResponse !== null && 'getReader' in aiResponse) {
		console.log('[getAiStream] aiResponse is a ReadableStream');
		const stream = aiResponse as ReadableStream;
		const reader = stream.getReader();
		const decoder = new TextDecoder();

		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				console.log('[getAiStream] reader.read() done: true');
				break;
			}

			const chunk = decoder.decode(value, { stream: true });
			const lines = chunk.split('\n');

			for (const line of lines) {
				if (line.startsWith('data: ')) {
					const data = line.slice(6);
					if (data === '[DONE]') {
						console.log('[getAiStream] data: [DONE] received');
						break;
					}
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
		yield extractText(aiResponse);
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
					.catch((e: Error) => console.error('Error sending final reply:', e));
			} else if (task.updateType === 'guest_message' && task.guestQueryId) {
				try {
					await ctx.api.answerGuestQuery(task.guestQueryId, {
						type: 'article',
						id: crypto.randomUUID(),
						title: 'AI Response',
						input_message_content: {
							message_text: await markdownToHtml(streamContent),
							parse_mode: 'HTML',
						},
					});
				} catch (e) {
					console.error('[streamAiResponseToTelegram] Failed to answer guest query:', e);
				}
			} else {
				console.log(`[streamAiResponseToTelegram] Sending final reply to business/guest: ${task.chatId}`);
				try {
					const result = await ctx.reply(await markdownToHtml(streamContent), {
						parse_mode: 'HTML',
						business_connection_id: task.businessConnectionId,
						reply_to_message_id: task.messageId,
					});
					console.log('[streamAiResponseToTelegram] Final business reply sent successfully:', JSON.stringify(result));
				} catch (e) {
					console.error('[streamAiResponseToTelegram] Failed to send final business reply:', e);
				}
			}
		} else {
			console.log('[streamAiResponseToTelegram] streamContent was empty, nothing to send.');
		}
	}
	return streamContent;
}
