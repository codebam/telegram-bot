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
	if (response.parts && Array.isArray(response.parts) && response.parts.length > 0) {
		let text = '';
		for (const part of response.parts) {
			if (part.text) text += part.text;
		}
		return text;
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
	const messages = [...input.messages];
	const tools = input.tools || [];
	const isGemini = model.includes('google/gemini');

	const cfTools = tools.map((t: Tool) => ({
		name: t.name,
		description: t.description,
		parameters: t.parameters
	}));

	const runModel = async (msgs: any[], stream: boolean) => {
		console.log(`[customRunWithTools] runModel starting. Stream: ${stream}, Model: ${model}`);
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
								parts: m.geminiParts
							};
						}
						
						let role = m.role === 'assistant' ? 'model' : 'user';
						const parts: any[] = [];
						if (m.content) parts.push({ text: m.content });
						return { role, parts };
					}),
					tools: cfTools.length > 0 ? [{
						functionDeclarations: cfTools
					}] : undefined,
					stream
				};
				if (systemMessage) {
					geminiInput.system_instruction = {
						parts: [{ text: systemMessage.content as string }]
					};
				}
				const res = await ai.run(model, geminiInput);
				return res;
			}
			
			const options: any = {
				messages: msgs,
				tools: cfTools.length > 0 ? cfTools.map(t => ({ type: 'function', function: t })) : undefined,
				stream,
				parallel_tool_calls: false,
				tool_choice: 'auto'
			};

			const res = await ai.run(model, options);
			return res;
		} catch (e) {
			console.error(`[customRunWithTools] ai.run failed for model ${model}:`, e);
			throw e;
		}
	};

	let turn = 0;
	while (turn < 5) {
		const shouldStream = turn === 4 || cfTools.length === 0 ? config.streamFinalResponse : false;
		const response = await runModel(messages, shouldStream);
		
		if (shouldStream || response instanceof ReadableStream) {
			return response;
		}

		const aiRes = response as AiResponse;
		let toolCalls: any[] = [];
		let geminiParts: any[] = [];

		if (aiRes?.tool_calls) {
			toolCalls = [...aiRes.tool_calls];
		} else if (aiRes?.choices?.[0]?.message?.tool_calls) {
			toolCalls = [...aiRes.choices[0].message.tool_calls];
		} else if (isGemini && aiRes?.candidates?.[0]?.content?.parts) {
			geminiParts = aiRes.candidates[0].content.parts;
			// Extract Gemini function calls
			for (const part of geminiParts as any[]) {
				if (part.functionCall) {
					toolCalls.push({
						id: `call_${Math.random().toString(36).substring(2, 9)}`,
						type: 'function',
						function: {
							name: part.functionCall.name,
							arguments: part.functionCall.args
						}
					});
				}
			}
		}

		let responseText = extractText(aiRes);

		if (toolCalls.length > 0) {
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
				tool_calls: normalizedToolCalls,
				geminiParts: isGemini ? geminiParts : undefined
			});

			for (const call of normalizedToolCalls) {
				const toolName = call.function.name;
				const toolId = call.id;
				const toolArgsString = call.function.arguments;
				const tool = tools.find((t: Tool) => t.name === toolName);

				if (tool && tool.function) {
					try {
						let parsedArgs;
						try {
							parsedArgs = JSON.parse(toolArgsString);
						} catch {
							parsedArgs = toolArgsString;
						}
						const result = await tool.function(parsedArgs);
						const content = typeof result === 'string' ? result : JSON.stringify(result);
						
						const toolMessage: any = { role: 'tool', tool_call_id: toolId, name: toolName, content };
						if (isGemini) {
							toolMessage.geminiParts = [{
								functionResponse: {
									name: toolName,
									response: { content }
								}
							}];
						}
						messages.push(toolMessage);
					} catch (e) {
						console.error(`[customRunWithTools] Tool execution failed: ${toolName}`, e);
						const content = `Error: ${String(e)}`;
						const toolMessage: any = { role: 'tool', tool_call_id: toolId, name: toolName, content };
						if (isGemini) {
							toolMessage.geminiParts = [{
								functionResponse: {
									name: toolName,
									response: { content }
								}
							}];
						}
						messages.push(toolMessage);
					}
				} else {
					const content = 'Tool not found';
					const toolMessage: any = { role: 'tool', tool_call_id: toolId, name: toolName, content };
					if (isGemini) {
						toolMessage.geminiParts = [{
							functionResponse: {
								name: toolName,
								response: { content }
							}
						}];
					}
					messages.push(toolMessage);
				}
			}
		} else {
			if (config.streamFinalResponse) {
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
			if (task.updateType === 'guest_message') {
				if (task.guestQueryId) {
					console.log('[streamAiResponseToTelegram] Answering guest_message via answerGuestQuery');
					const messageText = (await markdownToHtml(streamContent)).slice(0, 4096);
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
						.catch((e: any) => console.log('Error answering guest query:', e));
				} else {
					console.log('[streamAiResponseToTelegram] guest_message has no guestQueryId, cannot answer');
				}
			} else if (task.updateType !== 'business_message') {
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
