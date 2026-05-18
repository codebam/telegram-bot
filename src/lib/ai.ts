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

	if (response.choices && Array.isArray(response.choices) && response.choices.length > 0)
		return extractText(response.choices[0]);
	if (response.message) return extractText(response.message);
	if (response.delta) return extractText(response.delta);
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

	if (tools.length > 0) {
		let systemMsg = messages.find((m) => m.role === 'system');
		if (!systemMsg) {
			systemMsg = { role: 'system', content: '' };
			messages.unshift(systemMsg);
		}
		const toolInstructions = tools
			.map((t: Tool) => {
				return `- Name: ${t.name}\n  Description: ${t.description}\n  Parameters: ${JSON.stringify(t.parameters)}`;
			})
			.join('\n');

		const promptInstruction = `\n\n[SYSTEM INSTRUCTION] You have access to the following tools:\n${toolInstructions}\n\nTo use a tool, you MUST output a tool call wrapped in XML format, like so:\n<tool_call>{"name": "tavily_search", "arguments": {"query": "query" }}</tool_call>\nor\n<tool_call>{"name": "wikipedia", "arguments": {"query": "query" }}</tool_call>\n\nMake sure the tool call is outputted EXACTLY as shown. The system will intercept this call, execute the tool, and return the output to you. Do not write code or direct the user to run code; call the tools yourself.`;

		systemMsg.content = systemMsg.content + promptInstruction;
	}

	const runModel = async (msgs: any[], stream: boolean) => {
		if (isGemini) {
			const systemMessage = msgs.find((m) => m.role === 'system');
			const otherMessages = msgs.filter((m) => m.role !== 'system');
			const geminiInput: Record<string, unknown> = {
				contents: otherMessages.map((m) => ({
					role: m.role === 'assistant' ? 'model' : 'user',
					parts: [{ text: m.content as string }]
				})),
				stream
			};
			if (systemMessage) {
				geminiInput.system_instruction = {
					parts: [{ text: systemMessage.content as string }]
				};
			}
			return await ai.run(model, geminiInput);
		}
		return await ai.run(model, {
			messages: msgs,
			tools: cfTools.length > 0 ? cfTools : undefined,
			stream
		});
	};

	if (cfTools.length === 0) {
		return (await runModel(messages, config.streamFinalResponse)) as AiResponse | ReadableStream;
	}

	const response = (await runModel(messages, false)) as AiResponse;

	let toolCalls: any[] = [];
	if (response?.tool_calls) {
		toolCalls = [...response.tool_calls];
	} else if (response?.choices?.[0]?.message?.tool_calls) {
		toolCalls = [...response.choices[0].message.tool_calls];
	}

	let responseText = response?.response || response?.choices?.[0]?.message?.content || '';

	if (toolCalls.length === 0) {
		const gemmaRegex = /<\|tool_call>\s*call:\s*([a-zA-Z0-9_]+)([\s\S]*?)<tool_call\|>/g;
		const standardRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
		const markdownRegex = /```json\s*<tool_call>\s*([\s\S]*?)\s*<\/tool_call>\s*```/g;

		let match;
		while ((match = gemmaRegex.exec(responseText)) !== null) {
			let name = match[1].trim();
			if (name === 'http_fetch' || name === 'api_fetch') {
				name = 'fetch';
			}

			let argsString = match[2].trim();
			argsString = argsString
				.replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":')
				.replace(/:\s*'([^']*)'/g, ': "$1"');

			toolCalls.push({
				id: `call_${Math.random().toString(36).substring(2, 9)}`,
				type: 'function',
				function: { name, arguments: argsString }
			});
		}

		const processStandardMatch = (content: string) => {
			try {
				// Clean up potential backticks and language identifiers
				const cleaned = content.trim().replace(/^```json\s*/, '').replace(/\s*```$/, '');
				const parsed = JSON.parse(cleaned.replace(/'/g, '"'));
				const name = parsed.name || 'fetch';
				const args = parsed.arguments || parsed;
				toolCalls.push({
					id: `call_${Math.random().toString(36).substring(2, 9)}`,
					type: 'function',
					function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }
				});
			} catch (e) {
				console.error('Failed to parse tool call:', content, e);
			}
		};

		while ((match = markdownRegex.exec(responseText)) !== null) {
			processStandardMatch(match[1]);
		}

		while ((match = standardRegex.exec(responseText)) !== null) {
			processStandardMatch(match[1]);
		}

		responseText = responseText
			.replace(/```json\s*<tool_call>[\s\S]*?<\/tool_call>\s*```/g, '')
			.replace(/<\|tool_call>[\s\S]*?<tool_call\|>/g, '')
			.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
			.trim();
	}

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
			tool_calls: normalizedToolCalls
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
					messages.push({ role: 'tool', tool_call_id: toolId, name: toolName, content: String(result) });
				} catch (e) {
					messages.push({ role: 'tool', tool_call_id: toolId, name: toolName, content: String(e) });
				}
			} else {
				messages.push({ role: 'tool', tool_call_id: toolId, name: toolName, content: 'Tool not found' });
			}
		}

		return (await runModel(messages, config.streamFinalResponse)) as AiResponse | ReadableStream;
	}

	if (config.streamFinalResponse) {
		return (await runModel(messages, true)) as AiResponse | ReadableStream;
	}

	return response;
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
		const stream = aiResponse as ReadableStream;
		const reader = stream.getReader();
		const decoder = new TextDecoder();

		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}

			const chunk = decoder.decode(value, { stream: true });
			const lines = chunk.split('\n');

			for (const line of lines) {
				if (line.startsWith('data: ')) {
					const data = line.slice(6);
					if (data === '[DONE]') {
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
		// Fallback for when context is not a full Grammy context (e.g. in queue)
		// or for special message types
		const lastUpdate = { time: Date.now() };
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

		if (streamContent.trim()) {
			if (task.updateType !== 'guest_message' && task.updateType !== 'business_message') {
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
				try {
					await ctx.reply(await markdownToHtml(streamContent), {
						parse_mode: 'HTML',
						business_connection_id: task.businessConnectionId,
						reply_to_message_id: task.messageId,
					});
				} catch (e) {
					console.error('[streamAiResponseToTelegram] Failed to send final business reply:', e);
				}
			}
		}
	}
	return streamContent;
}
