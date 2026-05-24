import { Bot, Api, Context, webhookCallback, session, GrammyError, HttpError, InputFile } from 'grammy';
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { stream, type StreamFlavor } from '@grammyjs/stream';
import { Hono } from 'hono';

import { CommandGroup, type CommandsFlavor } from '@grammyjs/commands';
import { conversations, createConversation, type Conversation, type ConversationFlavor } from '@grammyjs/conversations';
import { KvAdapter } from '@grammyjs/storage-cloudflare';
import type { KVNamespace as CfKVNamespace } from '@cloudflare/workers-types';
import { HistoryManager, getBalance, sanitizeMarkdownV2, SYSTEM_PROMPTS, AVAILABLE_MODELS, verifyTelegramWebAppData, verifyTelegramLogin, logTransaction, type Task, type Environment, type GeminiPart, type ChatMessage } from '@codebam/shared';
import { fetchTool, wikipediaTool, createTavilySearchTool, createSandboxTool, createCodeWorkspaceTool } from './lib/utils.js';
import { createTelegramFileReaderTool, createTelegramFileSearchTool } from './lib/documentTool.js';
import { streamAiResponseToTelegram, customRunWithTools } from './lib/ai.js';

import { getSandbox } from '@cloudflare/sandbox';
export { Sandbox } from '@cloudflare/sandbox';

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	return Buffer.from(buffer).toString('base64');
}

async function syncUserSandboxWorkspace(userId: string, env: Environment): Promise<void> {
	try {
		const sandbox = getSandbox(env.Sandbox, userId);
		const uploadsList = await env.R2.list({ prefix: `uploads/${userId}/` });
		const activeFileNames: string[] = [];

		if (uploadsList && uploadsList.objects.length > 0) {
			for (const obj of uploadsList.objects) {
				const fileName = obj.key.split('/').pop();
				if (fileName) {
					activeFileNames.push(fileName);
					const cacheKey = `sandbox_sync:${userId}:${fileName}`;
					const cachedEtag = await env.CONVERSATION_HISTORY.get(cacheKey);
					if (cachedEtag === obj.etag) {
						console.log(`[SandboxSync] File ${fileName} already synced (etag match). Skipping.`);
						continue;
					}
					const fileData = await env.R2.get(obj.key);
					if (fileData) {
						const buffer = await fileData.arrayBuffer();
						const base64Data = arrayBufferToBase64(buffer);
						await sandbox.writeFile(`/workspace/${fileName}`, base64Data);
						await env.CONVERSATION_HISTORY.put(cacheKey, obj.etag);
						console.log(`[SandboxSync] Proactively synced uploaded file ${fileName} from R2 to sandbox.`);
					}
				}
			}
		}

		// Cleanup files in sandbox that are no longer in R2 uploads list
		const pythonCleanupCode = `
import os
import json

allowed = json.loads("""${JSON.stringify(activeFileNames)}""")
workspace_dir = "/workspace"

if os.path.exists(workspace_dir):
    removed_files = []
    for name in os.listdir(workspace_dir):
        path = os.path.join(workspace_dir, name)
        if os.path.isfile(path) and name not in allowed and name != "uploaded_image.png":
            try:
                os.remove(path)
                removed_files.append(name)
            except Exception as e:
                print(f"Error removing {name}: {e}")
    if removed_files:
        print(f"Cleaned up sandbox files: {', '.join(removed_files)}")
`.trim();

		const cleanupResult = await sandbox.runCode(pythonCleanupCode, { language: 'python' });
		const stdout = cleanupResult.logs.stdout.join('');
		if (stdout.trim()) {
			console.log(`[SandboxSync-Cleanup] ${stdout.trim()}`);
		}
	} catch (e) {
		console.warn(`[SandboxSync] Sync failed for user ${userId}:`, e);
	}
}

type BaseContext = CommandsFlavor &
	Context & {
		env: Environment;
		executionCtx: ExecutionContext;
		session: Record<string, unknown>;
	};

type MyContext = StreamFlavor<BaseContext & ConversationFlavor<BaseContext>>;

type MyConversation = Conversation<MyContext, MyContext>;

async function getBusinessOwnerData(
	api: Api,
	env: Environment,
	connectionId: string
): Promise<{ id: number; name: string; username?: string } | null> {
	let ownerData = await env.CONVERSATION_HISTORY.get<{ id: number; name: string; username?: string }>(
		`business_connection:${connectionId}`,
		'json'
	);
	if (ownerData) {
		console.log(`[getBusinessOwnerData] Cache HIT for connection ${connectionId}:`, JSON.stringify(ownerData));
	} else {
		console.log(`[getBusinessOwnerData] Cache MISS or stale entry for connection ${connectionId}. Fetching from Telegram API...`);
		try {
			const result = await api.getBusinessConnection(connectionId);
			const id = result.user?.id || result.user_chat_id;
			const name = result.user?.first_name || 'the business owner';
			const username = result.user?.username;
			if (id) {
				ownerData = { id, name, username };
				console.log(`[getBusinessOwnerData] Successfully resolved owner: id=${id}, name=${name}, username=${username ?? ''}. Caching in KV...`);
				await env.CONVERSATION_HISTORY.put(
					`active_connection:${id}`,
					connectionId
				);
				await env.CONVERSATION_HISTORY.put(
					`business_connection:${connectionId}`,
					JSON.stringify(ownerData)
				);
			} else {
				console.error(`[getBusinessOwnerData] Failed to resolve owner ID from result:`, JSON.stringify(result));
			}
		} catch (e) {
			console.error('[getBusinessOwnerData] Failed to fetch business connection:', e);
		}
	}
	return ownerData;
}

async function chargeStars(
	ctx: MyContext,
	task: Task,
	amountOverride?: number
) {
	const historyManager = new HistoryManager(ctx.env.CONVERSATION_HISTORY);
	let userId: number | string | undefined = ctx.from?.id;
	let billingUserId = ctx.from?.id;

	if (ctx.has('business_message')) {
		const bizMsg = ctx.businessMessage;
		const connectionId = bizMsg.business_connection_id;
		const customerId = bizMsg.chat.id;
		if (connectionId && customerId) {
			userId = `business:${connectionId}:${customerId}`;
			const ownerData = await getBusinessOwnerData(ctx.api, ctx.env, connectionId);
			if (ownerData?.id) {
				billingUserId = ownerData.id;
			}
		}
	}

	if (ctx.update.guest_message) {
		userId = userId || ctx.update.guest_message.from?.id;
		billingUserId = billingUserId || ctx.update.guest_message.from?.id;
	}

	if (!userId || userId === ctx.me.id) {
		console.log(`Skipping chargeStars: userId=${userId}, botId=${ctx.me.id}`);
		return;
	}

	task.userId = userId;
	task.senderId = ctx.from?.id || ctx.update.guest_message?.from?.id;
	task.chatId = ctx.chatId?.toString() || ctx.update.guest_message?.chat?.id?.toString();
	task.updateId = ctx.update.update_id;
	task.messageId = ctx.msg?.message_id || ctx.update.guest_message?.message_id;
	task.updateType = Object.keys(ctx.update).find((k) => k !== 'update_id');
	task.guestQueryId = ctx.update.guest_message?.guest_query_id;
	task.businessConnectionId = ctx.businessMessage?.business_connection_id?.toString();
	task.threadId = ctx.msg?.message_thread_id || ctx.update.guest_message?.message_thread_id;
	
	if (ctx.update.update_id) {
		const processedKey = `processed_update:${String(ctx.update.update_id)}`;
		const alreadyProcessed = await ctx.env.CONVERSATION_HISTORY.get(processedKey);
		if (alreadyProcessed) {
			console.log(`[chargeStars] Update ${ctx.update.update_id} already processed. Skipping duplicate workflow.`);
			return;
		}
	}
	
	const balanceKey = `balance:${String(billingUserId)}`;
	const balance = await getBalance(billingUserId || 0, ctx.env.CONVERSATION_HISTORY);

	const modelPreference =
		(await ctx.env.CONVERSATION_HISTORY.get<string>(`model:${String(billingUserId)}`)) ?? 'glm-4.7-flash';
	const modelConfig = AVAILABLE_MODELS[modelPreference] ?? AVAILABLE_MODELS['glm-4.7-flash'];

	if (task.type === 'tool_call' && !modelConfig.supportsTools) {
		task.modelId = AVAILABLE_MODELS['glm-4.7-flash'].id;
	} else if ((task.type === 'photo' || task.geminiParts?.some((p) => p.inlineData)) && !modelConfig.supportsVision) {
		task.modelId = AVAILABLE_MODELS['google/gemini-3.1-flash-lite'].id;
	} else {
		task.modelId = modelConfig.id;
	}

	const amount = amountOverride ?? modelConfig.cost;

	if (balance >= amount) {
		try {
			await ctx.replyWithChatAction('typing', {
				business_connection_id: ctx.businessMessage?.business_connection_id,
			});
		} catch (e) {
			console.log('[chargeStars] Failed to send chat action (likely not a member):', e);
		}
		const newBalance = balance - amount;
		await ctx.env.CONVERSATION_HISTORY.put(balanceKey, JSON.stringify(newBalance));
		await logTransaction(billingUserId || 0, ctx.env.CONVERSATION_HISTORY, {
			amount,
			type: 'charge',
			model: task.modelId,
			taskType: task.type,
			newBalance,
			description: 'AI Bot message charge'
		});
		task.telegramToken = ctx.env.SECRET_TELEGRAM_API_TOKEN;

		if (ctx.has('business_message')) {
			if (!task.systemPrompt) {
				let prompt = SYSTEM_PROMPTS.BUSINESS_MODE;
				const connectionId = ctx.businessMessage.business_connection_id;
				if (connectionId) {
					const ownerData = await getBusinessOwnerData(ctx.api, ctx.env, connectionId);
					if (ownerData) {
						const customPrompt = await ctx.env.CONVERSATION_HISTORY.get(`prompt:${String(ownerData.id)}`);
						if (customPrompt) {
							prompt = customPrompt;
						}
						prompt = prompt.replace(/{owner_name}/g, ownerData.name);
						const facts = await ctx.env.CONVERSATION_HISTORY.get(`business_facts:${String(ownerData.id)}`);
						if (facts) {
							prompt += `\n\nHere are some facts about you:\n${facts}`;
						}
					}
				}
				task.systemPrompt = prompt;
			}
		} else {
			const customPrompt = await ctx.env.CONVERSATION_HISTORY.get(`prompt:${String(userId)}`);
			if (customPrompt) {
				task.systemPrompt = customPrompt;
			} else if (!task.systemPrompt) {
				task.systemPrompt = SYSTEM_PROMPTS.TUX_ROBOT;
			}
		}

		if (!task.history && userId) {
			task.history = await historyManager.getHistory(userId, task.threadId);
		}

		await ctx.env.STREAM_WORKFLOW.create({
			params: task,
		});
	} else {
		if (ctx.has('business_message') || ctx.has('guest_message')) {
			await ctx.reply(
				'Insufficient balance. Please go to direct messages and use /load to top up your Stars.',
				{
					business_connection_id: ctx.businessMessage?.business_connection_id,
					reply_parameters: { message_id: ctx.msgId },
				}
			);
		} else {
			const taskId = crypto.randomUUID();
			await ctx.env.CONVERSATION_HISTORY.put(`task:${taskId}`, JSON.stringify(task), {
				expirationTtl: 3600
			});
			await ctx.replyWithInvoice(
				'AI Generation',
				'Charge for AI message generation',
				taskId,
				'XTR',
				[{ label: 'Stars', amount }]
			);
		}
	}
}

export function createChatConversation(env: Environment, executionCtx: ExecutionContext) {
	return async function chatConversation(conversation: MyConversation, ctx: MyContext) {
		ctx.env = env;
		ctx.executionCtx = executionCtx;
		let userId: number | string = ctx.from!.id;
		const threadId = ctx.msg?.message_thread_id;

		if (ctx.has('business_message')) {
			const bizMsg = ctx.businessMessage;
			const connectionId = bizMsg.business_connection_id;
			const customerId = bizMsg.chat.id;
			if (connectionId && customerId) {
				userId = `business:${connectionId}:${customerId}`;
			}
		}

		while (true) {
			// Initialize history from KV if it exists, otherwise start fresh
			const history = (await conversation.external(async () => {
				const historyManager = new HistoryManager(env.CONVERSATION_HISTORY);
				return await historyManager.getHistory(userId, threadId);
			})) || [];

			let prompt = ctx.msg?.text || ctx.msg?.caption || '';

			const geminiParts: GeminiPart[] = [];
			const photo = ctx.msg?.photo;
			if (photo) {
				const largestPhoto = photo[photo.length - 1];
				const file = await conversation.external(() => ctx.api.getFile(largestPhoto.file_id));
				const fileUrl = `https://api.telegram.org/file/bot${env.SECRET_TELEGRAM_API_TOKEN}/${file.file_path}`;
				const base64Data = await conversation.external(async () => {
					const fileRes = await fetch(fileUrl);
					if (fileRes.ok) {
						const arrayBuffer = await fileRes.arrayBuffer();
						return arrayBufferToBase64(arrayBuffer);
					}
					return null;
				});
				if (base64Data) {
					geminiParts.push({
						inlineData: {
							mimeType: 'image/jpeg',
							data: base64Data
						}
					});
				}
				if (!prompt) {
					prompt = 'Please describe this image';
				}
			}

			let billingUserId = ctx.from?.id;
			let ownerData: { id: number; name: string; username?: string } | null = null;
			if (ctx.has('business_message')) {
				const connectionId = ctx.businessMessage.business_connection_id;
				if (connectionId) {
					ownerData = await conversation.external(() => getBusinessOwnerData(ctx.api, env, connectionId));
					if (ownerData?.id) {
						billingUserId = ownerData.id;
					}
				}
			}

			const { balance, modelPreference } = await conversation.external(async () => {
				const b = await getBalance(billingUserId || 0, env.CONVERSATION_HISTORY);
				const mp = (await env.CONVERSATION_HISTORY.get<string>(`model:${String(billingUserId)}`)) ?? 'glm-4.7-flash';
				return { balance: b, modelPreference: mp };
			});

			const modelConfig = AVAILABLE_MODELS[modelPreference] ?? AVAILABLE_MODELS['glm-4.7-flash'];

			if (ctx.msg?.document) {
				const doc = ctx.msg.document;
				prompt = `[Uploaded Document: Name="${doc.file_name || 'document'}", MIME="${doc.mime_type || ''}", FileID="${doc.file_id}"]\n\n${prompt || 'Please process this document.'}`;
			}

			const replyToMessage = ctx.msg?.reply_to_message;
			if (replyToMessage) {
				if (replyToMessage.document) {
					const replyDoc = replyToMessage.document;
					const replyText = replyToMessage.caption || '';
					prompt = `Context of the uploaded document I am replying to: Name="${replyDoc.file_name || 'document'}", MIME="${replyDoc.mime_type || ''}", FileID="${replyDoc.file_id}"${replyText ? ` with caption "${replyText}"` : ''}\n\nMy message: ${prompt}`;
				} else {
					const replyText = replyToMessage.text || replyToMessage.caption || '';
					if (replyText) {
						prompt = `Context of the message I am replying to: "${replyText}"\n\nMy message: ${prompt}`;
					}
				}
			}

			if (prompt) {
				if (geminiParts.some((p) => p.inlineData) && !modelConfig.supportsVision) {
					await ctx.reply(
						`⚠️ Your current model (*${sanitizeMarkdownV2(modelPreference)}*) does not support vision/images\\.\n\n` +
							`Please switch to a vision\\-enabled model using:\n` +
							`\\- \`/model kimi-k2.6\` \\(40 Stars\\)\n` +
							`\\- \`/model gemma4\` \\(10 Stars\\)\n` +
							`\\- \`/model google/gemini-3.1-flash-lite\` \\(10 Stars\\)\n` +
							`\\- \`/model llama-3.2-vision\` \\(10 Stars\\)\n` +
							`\\- \`/model google/gemini-3.1-pro\` \\(80 Stars\\)`,
						{ parse_mode: 'MarkdownV2' }
					);
					ctx = await conversation.wait();
					continue;
				}

				const amount = modelConfig.cost;

				if (balance >= amount) {
					try {
						await ctx.replyWithChatAction('typing', {
							business_connection_id: ctx.businessMessage?.business_connection_id,
						});
					} catch (e) {
						console.error('[chatConversation] Failed to send chat action:', e);
					}
					const balanceKey = `balance:${String(billingUserId)}`;
					const newBalance = balance - amount;
					await conversation.external(async () => {
						await env.CONVERSATION_HISTORY.put(balanceKey, JSON.stringify(newBalance));
						await logTransaction(billingUserId || 0, env.CONVERSATION_HISTORY, {
							amount,
							type: 'charge',
							model: modelConfig.id,
							taskType: ctx.has('business_message') ? 'business_message' : 'message',
							newBalance,
							description: 'AI Bot message charge'
						});
					});

					const systemPrompt = await conversation.external(async () => {
						if (ctx.has('business_message')) {
							let prompt = SYSTEM_PROMPTS.BUSINESS_MODE;
							if (ownerData) {
								const customPrompt = await env.CONVERSATION_HISTORY.get(`prompt:${String(ownerData.id)}`);
								if (customPrompt) {
									prompt = customPrompt;
								}
								prompt = prompt.replace(/{owner_name}/g, ownerData.name);
								const facts = await env.CONVERSATION_HISTORY.get(`business_facts:${String(ownerData.id)}`);
								if (facts) {
									prompt += `\n\nHere are some facts about you:\n${facts}`;
								}
							}
							return prompt;
						}
						const isFileTask = !!ctx.msg?.document || !!(replyToMessage && replyToMessage.document);
						const customPrompt = await env.CONVERSATION_HISTORY.get(`prompt:${String(userId)}`);
						if (isFileTask) {
							if (customPrompt) {
								return customPrompt + '\n\nEnsure your responses are formatted using supported Telegram MarkdownV2.';
							}
							return 'You are a helpful assistant running on Telegram. Ensure your responses are formatted using supported Telegram MarkdownV2.';
						}
						return customPrompt || SYSTEM_PROMPTS.TUX_ROBOT;
					});

					const userMessage: ChatMessage = { role: 'user', content: prompt };
					if (geminiParts.length > 0) {
						userMessage.geminiParts = [
							{ text: prompt || 'Please describe this image' },
							...geminiParts
						];
					}

					const modelId = modelConfig.id;

					await conversation.external(async () => {
						await ctx.env.STREAM_WORKFLOW.create({
							params: {
								type: ctx.has('business_message') ? 'business_message' : 'message',
								updateType: ctx.has('business_message') ? 'business_message' : 'message',
								prompt,
								chatId: ctx.chatId?.toString(),
								threadId,
								businessConnectionId: ctx.businessMessage?.business_connection_id?.toString(),
								messageId: ctx.msgId,
								userId: String(userId),
								systemPrompt,
								history,
								telegramToken: env.SECRET_TELEGRAM_API_TOKEN,
								modelId,
							},
						});
					});
				} else {
					// Handle insufficient balance (omitted full logic for brevity, can call ctx.replyWithInvoice)
					await ctx.reply('Insufficient balance. Please top up your Stars.');
					break;
				}
			}

			ctx = (await conversation.wait()) as MyContext;
			ctx.env = env;
			ctx.executionCtx = executionCtx;
		}
	};
}

function setupBot(bot: Bot<MyContext>, env: Environment, executionCtx: ExecutionContext) {
	bot.use(async (ctx, next) => {
		const updateType = Object.keys(ctx.update).find(k => k !== 'update_id');
		console.log(`[Grammy-Update] Received update: ${ctx.update.update_id}, Type: ${updateType}`);
		ctx.env = env;
		ctx.executionCtx = executionCtx;
		try {
			await next();
			console.log(`[Grammy-Update] Finished handling update ${ctx.update.update_id}`);
		} catch (e) {
			console.error(`[Grammy-Update] Error handling update ${ctx.update.update_id}:`, e);
			if (e instanceof GrammyError) {
				console.error(`[Grammy-Error-Detail] Method: ${e.method}, Error Code: ${e.error_code}, Description: ${e.description}`);
			} else if (e instanceof HttpError) {
				console.error(`[Grammy-Error-Detail] HTTP network connection error contacting Telegram API.`, e);
			} else if (e instanceof Error) {
				console.error(`[Grammy-Error-Detail] Stack trace:\n${e.stack}`);
			}
			throw e;
		}
	});

	bot.api.config.use(async (prev, method, payload, signal) => {
		console.log(`[Grammy-API] Request: ${method}, Payload:`, JSON.stringify(payload));
		let attempt = 0;
		const maxAttempts = 3;
		let delay = 1000;
		while (true) {
			try {
				const res = await prev(method, payload, signal);
				console.log(`[Grammy-API] Success: ${method}`);
				return res;
			} catch (e: any) {
				attempt++;
				const isRateLimit = e?.error_code === 429 || e?.status === 429 || String(e).includes('429');
				if (isRateLimit && attempt < maxAttempts) {
					const retryAfter = e?.parameters?.retry_after || (delay / 1000);
					console.warn(`[Grammy-API] 429 Rate limited on ${method}. Retrying in ${retryAfter}s. Attempt ${attempt}/${maxAttempts}`);
					await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
					delay *= 2;
				} else {
					console.error(`[Grammy-API] Error in ${method} on attempt ${attempt}:`, e);
					throw e;
				}
			}
		}
	});

	bot.use(stream());

	bot.use(
		session({
			initial: () => ({}),
			storage: new KvAdapter(env.CONVERSATION_HISTORY as unknown as CfKVNamespace),
		}),
	);
	bot.use(conversations());
	bot.use(createConversation(createChatConversation(env, executionCtx), 'chatConversation'));

	const commands = new CommandGroup<MyContext>();

	commands.command('start', 'Welcome message and command list', async (ctx) => {
		const isDev = ctx.env.ENVIRONMENT === 'dev';
		const message = 'Welcome! Here are my commands:\n' +
			'/balance - Check your current Star balance\n' +
			'/load <amount> - Top up your balance with Telegram Stars\n' +
			'/photo <prompt> - Generate an image (100 Stars)\n' +
			'/model <name> - Switch AI model and see costs\n' +
			'/prompt ["prompt"] - Set your custom system prompt (no args to view, "" or reset to clear)\n' +
			'/facts ["facts"] - Set facts about yourself for business mode (no args to view, "" or reset to clear)\n' +
			'<prompt> - Generate text (may use tools if supported by model)\n' +
			'Send a voice note - Transform your bot into a voice assistant (+20 Stars)\n' +
			'/clear - Clear your conversation history\n' +
			'/commit - Get the latest deployed commit link\n\n' +
			'New users start with 200 free credits!' +
			(isDev ? '' : '\n\nClick the button below to open the Web App!');

		await ctx.reply(message, {
			reply_markup: isDev ? undefined : {
				inline_keyboard: [[{ text: 'Open Web App', web_app: { url: 'https://tux-robot.codebam.ca' } }]],
			},
		});
	});

	commands.command('balance', 'Check your current Star balance', async (ctx) => {
		const balance = await getBalance(ctx.from?.id || 0, ctx.env.CONVERSATION_HISTORY);
		await ctx.reply(`Your current balance is ${String(balance)} Stars.`);
	});

	commands.command('load', 'Top up your balance with Telegram Stars', async (ctx) => {
		const amount = parseInt(ctx.match || '0');
		if (isNaN(amount) || amount <= 0 || amount > 1000) {
			await ctx.reply('Please specify an amount between 1 and 1000 Stars. Example: /load 100');
		} else {
			await ctx.replyWithInvoice('Stars Top-up', `Purchase ${String(amount)} Stars`, `load:${String(amount)}`, 'XTR', [
				{ label: 'Stars', amount },
			]);
		}
	});

	commands.command('photo', 'Generate an image', async (ctx) => {
		const prompt = ctx.match;
		if (prompt) {
			await chargeStars(ctx, { type: 'gen_photo', prompt }, 100);
		} else {
			await ctx.reply('Please provide a prompt for the photo. Example: /photo a futuristic city');
		}
	});

	commands.command('clear', 'Clear your conversation history', async (ctx) => {
		const historyManager = new HistoryManager(ctx.env.CONVERSATION_HISTORY);
		let historyUserId: number | string = ctx.from?.id || 0;
		if (ctx.update.business_message) {
			const bizMsg = ctx.update.business_message;
			const connectionId = bizMsg.business_connection_id;
			const customerId = bizMsg.chat.id;
			if (connectionId && customerId) {
				historyUserId = `business:${connectionId}:${customerId}`;
			}
		}
		const threadId = ctx.msg?.message_thread_id || ctx.update.guest_message?.message_thread_id;
		await historyManager.clearHistory(historyUserId, threadId);
		await ctx.reply('History cleared');
	});

	commands.command('model', 'Switch AI model and see costs', async (ctx) => {
		const modelKey = `model:${String(ctx.from?.id)}`;
		const selectedModel = ctx.match?.toLowerCase();
		if (selectedModel) {
			if (selectedModel in AVAILABLE_MODELS) {
				await ctx.env.CONVERSATION_HISTORY.put(modelKey, selectedModel);
				await ctx.reply(`Model updated to *${sanitizeMarkdownV2(selectedModel)}*\\.`, { parse_mode: 'MarkdownV2' });
			} else {
				await ctx.reply(`Invalid model\\. Available models:\n${Object.keys(AVAILABLE_MODELS).join('\n')}`);
			}
		} else {
			const currentModel = (await ctx.env.CONVERSATION_HISTORY.get<string>(modelKey)) ?? 'glm-4.7-flash';
			await ctx.reply(
				`Current model: *${sanitizeMarkdownV2(currentModel)}*\n\n` +
					`Available models:\n` +
					Object.entries(AVAILABLE_MODELS)
						.map(([name, cfg]) => `\\- \`${name.replace(/[`\\]/g, '\\$&')}\` \\(${String(cfg.cost)} Stars\\)`)
						.join('\n'),
				{ parse_mode: 'MarkdownV2' },
			);
		}
	});

	commands.command('prompt', 'Set your custom system prompt', async (ctx) => {
		let promptValue = (ctx.match || '').trim();
		const userId = String(ctx.from?.id);

		if (promptValue === '') {
			const customPrompt = await ctx.env.CONVERSATION_HISTORY.get(`prompt:${userId}`);
			await ctx.reply(`Current system prompt:\n\n${customPrompt || SYSTEM_PROMPTS.TUX_ROBOT}`);
			return;
		}

		if (promptValue === 'reset' || promptValue === '""' || promptValue === "''") {
			await ctx.env.CONVERSATION_HISTORY.delete(`prompt:${userId}`);
			await ctx.reply(`System prompt reset to default:\n\n${SYSTEM_PROMPTS.TUX_ROBOT}`);
		} else {
			if (
				(promptValue.startsWith('"') && promptValue.endsWith('"')) ||
				(promptValue.startsWith("'") && promptValue.endsWith("'"))
			) {
				promptValue = promptValue.substring(1, promptValue.length - 1);
			}
			await ctx.env.CONVERSATION_HISTORY.put(`prompt:${userId}`, promptValue);
			await ctx.reply(`System prompt updated to:\n\n${promptValue}`);
		}
	});

	commands.command('facts', 'Set facts about yourself for business mode', async (ctx) => {
		let factsValue = (ctx.match || '').trim();
		const userId = ctx.from?.id;
		if (!userId) return;

		if (factsValue === '') {
			const facts = await ctx.env.CONVERSATION_HISTORY.get(`business_facts:${String(userId)}`);
			await ctx.reply(`Current business facts:\n\n${facts || 'No facts set.'}`);
			return;
		}

		if (factsValue === 'reset' || factsValue === '""' || factsValue === "''") {
			await ctx.env.CONVERSATION_HISTORY.delete(`business_facts:${String(userId)}`);
			const connectionId = await ctx.env.CONVERSATION_HISTORY.get(`active_connection:${userId}`);
			if (connectionId) {
				const ownerData = await ctx.env.CONVERSATION_HISTORY.get<{ id: number; name: string; username?: string }>(
					`business_connection:${connectionId}`,
					'json',
				);
				if (ownerData) {
					if (ownerData.username) {
						await ctx.env.CONVERSATION_HISTORY.delete(`business_facts:${ownerData.username}`);
					}
					if (ownerData.name) {
						await ctx.env.CONVERSATION_HISTORY.delete(`business_facts:${ownerData.name}`);
					}
				}
			}
			await ctx.reply('Business facts cleared.');
		} else {
			if (
				(factsValue.startsWith('"') && factsValue.endsWith('"')) ||
				(factsValue.startsWith("'") && factsValue.endsWith("'"))
			) {
				factsValue = factsValue.substring(1, factsValue.length - 1);
			}
			await ctx.env.CONVERSATION_HISTORY.put(`business_facts:${String(userId)}`, factsValue);
			const connectionId = await ctx.env.CONVERSATION_HISTORY.get(`active_connection:${userId}`);
			if (connectionId) {
				const ownerData = await ctx.env.CONVERSATION_HISTORY.get<{ id: number; name: string; username?: string }>(
					`business_connection:${connectionId}`,
					'json',
				);
				if (ownerData) {
					if (ownerData.username) {
						await ctx.env.CONVERSATION_HISTORY.put(`business_facts:${ownerData.username}`, factsValue);
					}
					if (ownerData.name) {
						await ctx.env.CONVERSATION_HISTORY.put(`business_facts:${ownerData.name}`, factsValue);
					}
				}
			}
			await ctx.reply(`Business facts updated to:\n\n${factsValue}`);
		}
	});

	commands.command('commit', 'Get the latest deployed commit link', async (ctx) => {
		const commitSha = ctx.env.COMMIT_SHA || 'unknown';
		if (commitSha === 'unknown' || commitSha === 'dev') {
			await ctx.reply(`Commit: \`${commitSha}\``);
		} else {
			const link = `https://codeberg.org/codebam/cf-workers-telegram-bot/commit/${commitSha}`;
			await ctx.reply(`Latest deployed commit: [${commitSha.substring(0, 7)}](${link})`, {
				parse_mode: 'Markdown',
			});
		}
	});

	bot.use(commands);

	bot.on('message:document', async (ctx) => {
		await ctx.conversation.enter('chatConversation');
	});

	bot.on('pre_checkout_query', async (ctx) => {
		await ctx.answerPreCheckoutQuery(true);
	});

	bot.on('message:successful_payment', async (ctx) => {
		const payment = ctx.message.successful_payment;
		const payload = payment.invoice_payload;
		const userId = ctx.from?.id;
		if (!userId) return;

		if (payload.startsWith('load:')) {
			const amount = parseInt(payload.split(':')[1]);
			const balanceKey = `balance:${String(userId)}`;
			const newBalance = balance + amount;
			await ctx.env.CONVERSATION_HISTORY.put(balanceKey, JSON.stringify(newBalance));
			await logTransaction(userId, ctx.env.CONVERSATION_HISTORY, {
				amount,
				type: 'load',
				newBalance,
				description: 'Telegram Stars Top-up'
			});
			await ctx.reply(`Successfully loaded ${String(amount)} Stars! New balance: ${String(newBalance)} Stars.`);
			return;
		}

		const taskId = payload;
		const task = await ctx.env.CONVERSATION_HISTORY.get<Task>(`task:${taskId}`, 'json');
		if (!task) {
			await ctx.reply('Error: Task not found');
			return;
		}
		task.telegramToken = ctx.env.SECRET_TELEGRAM_API_TOKEN;
		await ctx.env.STREAM_WORKFLOW.create({
			params: task,
		});
		await ctx.env.CONVERSATION_HISTORY.delete(`task:${taskId}`);
	});

	bot.on('message:photo', async (ctx) => {
		await ctx.conversation.enter('chatConversation');
	});

	bot.on('message:voice', async (ctx) => {
		const fileId = ctx.message.voice.file_id;
		await chargeStars(ctx, { type: 'voice', prompt: '', fileId });
	});


	bot.on('business_connection', async (ctx) => {
		const connection = ctx.businessConnection;
		const ownerName = connection.user.first_name;
		const username = connection.user.username;
		const ownerId = connection.user.id;
		await ctx.env.CONVERSATION_HISTORY.put(`active_connection:${ownerId}`, connection.id);
		await ctx.env.CONVERSATION_HISTORY.put(
			`business_connection:${connection.id}`,
			JSON.stringify({
				id: ownerId,
				name: ownerName || 'the business owner',
				username: username,
			}),
		);
	});

	bot.on('business_message', async (ctx) => {
		await ctx.conversation.enter('chatConversation');
	});

	bot.on('message:text', async (ctx) => {
		await ctx.conversation.enter('chatConversation');
	});

	bot.on('guest_message', async (ctx) => {
		const guestMessage = ctx.update.guest_message!;
		let prompt = guestMessage.text?.toString() ?? '';
		const token = ctx.env.SECRET_TELEGRAM_API_TOKEN;
		let botUsername = await ctx.env.CONVERSATION_HISTORY.get(`bot_username:${token.slice(0, 10)}`);
		if (!botUsername) {
			botUsername = ctx.me.username;
			await ctx.env.CONVERSATION_HISTORY.put(`bot_username:${token.slice(0, 10)}`, botUsername, {
				expirationTtl: 86400,
			});
		}
		const isMentioned = guestMessage.entities?.some(
			(e: { type: string; offset: number; length: number }) =>
				e.type === 'mention' && prompt.substring(e.offset, e.offset + e.length).toLowerCase() === `@${botUsername?.toLowerCase()}`,
		);
		if (!isMentioned) return;

		if (guestMessage.reply_to_message) {
			const reply = guestMessage.reply_to_message;
			const replyText = reply.text ?? reply.caption ?? '';
			if (replyText) {
				prompt = `Context of the message I am replying to: "${replyText}"\n\nMy message: ${prompt}`;
			}
		}

		if (prompt.includes('/start') && guestMessage.guest_query_id) {
			try {
				const isDev = ctx.env.ENVIRONMENT === 'dev';
				const messageText = 'Welcome! Here are my commands:\n' +
					'/balance - Check your current Star balance\n' +
					'/load <amount> - Top up your balance with Telegram Stars\n' +
					'/photo <prompt> - Generate an image (100 Stars)\n' +
					'/model <name> - Switch AI model and see costs\n' +
					'/prompt ["prompt"] - Set your custom system prompt (no args to view, "" or reset to clear)\n' +
					'/facts ["facts"] - Set facts about yourself for business mode (no args to view, "" or reset to clear)\n' +
					'<prompt> - Generate text (may use tools if supported by model)\n' +
					'Send a voice note - Transform your bot into a voice assistant (+20 Stars)\n' +
					'/clear - Clear your conversation history\n\n' +
					'New users start with 200 free credits!' +
					(isDev ? '' : '\n\nClick the button below to open the Web App!');

				await ctx.api.answerGuestQuery(guestMessage.guest_query_id, {
					type: 'article',
					id: crypto.randomUUID(),
					title: 'Welcome',
					input_message_content: {
						message_text: messageText,
					},
					reply_markup: isDev ? undefined : {
						inline_keyboard: [
							[{ text: 'Open Web App', url: 'https://tux-robot.codebam.ca' }],
						],
					},
				});
			} catch (e) {
				console.error('[guest_message] Failed to answer guest query:', e);
			}
			return;
		}

		await chargeStars(ctx, { type: 'message', prompt });
	});

	bot.catch((err) => {
		const ctx = err.ctx;
		const e = err.error;
		console.error(`[Grammy-Error] Error while handling update ${ctx?.update?.update_id}:`);
		if (e instanceof GrammyError) {
			console.error(`[Grammy-Error-Detail] Method: ${e.method}, Error Code: ${e.error_code}, Description: ${e.description}`);
		} else if (e instanceof HttpError) {
			console.error(`[Grammy-Error-Detail] HTTP network connection error contacting Telegram API.`, e);
		} else if (e instanceof Error) {
			console.error(`[Grammy-Error-Detail] Unknown error:`, e.message);
			console.error(`[Grammy-Error-Detail] Stack trace:\n${e.stack}`);
		} else {
			console.error(`[Grammy-Error-Detail] Unknown error object:`, e);
		}
	});
}

async function processTask(task: Task, env: Environment): Promise<void> {
	try {
		if (task.updateId) {
			const processedKey = `processed_update:${String(task.updateId)}`;
			const alreadyProcessed = await env.CONVERSATION_HISTORY.get(processedKey);
			if (alreadyProcessed) {
				console.log(`[processTask] Update ${task.updateId} already processed. Skipping duplicate execution.`);
				return;
			}
			await env.CONVERSATION_HISTORY.put(processedKey, 'true', { expirationTtl: 3600 });
		}

		// Proactively sync user uploaded files from R2 to Sandbox /workspace/ and cleanup deleted files
		await syncUserSandboxWorkspace(String(task.userId), env);

		const token = env.SECRET_TELEGRAM_API_TOKEN;
		if (!token) {
			throw new Error('SECRET_TELEGRAM_API_TOKEN is empty in processTask');
		}
		const botInstance = new Bot<MyContext>(token);
		botInstance.api.config.use(async (prev, method, payload, signal) => {
			let attempt = 0;
			const maxAttempts = 3;
			let delay = 1000;
			while (true) {
				try {
					return await prev(method, payload, signal);
				} catch (e: any) {
					attempt++;
					const isRateLimit = e?.error_code === 429 || e?.status === 429 || String(e).includes('429');
					if (isRateLimit && attempt < maxAttempts) {
						const retryAfter = e?.parameters?.retry_after || (delay / 1000);
						console.warn(`[processTask-API] 429 Rate limited on ${method}. Retrying in ${retryAfter}s. Attempt ${attempt}/${maxAttempts}`);
						await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
						delay *= 2;
					} else {
						throw e;
					}
				}
			}
		});

		if (task.type === 'voice' && task.fileId) {
			try {
				const file = await botInstance.api.getFile(task.fileId);
				const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
				const fileRes = await fetch(fileUrl);
				if (fileRes.ok) {
					const audioData = await fileRes.arrayBuffer();
					const hashBuffer = await crypto.subtle.digest('SHA-256', audioData);
					const hashHex = Array.from(new Uint8Array(hashBuffer))
						.map((b) => b.toString(16).padStart(2, '0'))
						.join('');
					const cacheKey = `whisper_cache:${hashHex}`;
					let transcriptionText = await env.CONVERSATION_HISTORY.get(cacheKey);
					if (!transcriptionText) {
						console.log(`[processTask] Whisper Cache MISS. Running Whisper AI...`);
						const transcription = (await env.AI.run('@cf/openai/whisper', {
							audio: [...new Uint8Array(audioData)],
						})) as { text: string };
						transcriptionText = transcription.text || '';
						if (transcriptionText) {
							await env.CONVERSATION_HISTORY.put(cacheKey, transcriptionText, { expirationTtl: 86400 * 7 });
						}
					} else {
						console.log(`[processTask] Whisper Cache HIT. Using cached transcription.`);
					}
					if (transcriptionText) {
						task.prompt = transcriptionText;
						task.type = 'message';
					}
				}
			} catch (e) {
				console.error('[processTask] Failed to transcribe voice:', e);
				await botInstance.api.sendMessage(task.chatId!, 'Failed to transcribe voice message.', {
					business_connection_id: task.businessConnectionId,
					reply_parameters: { message_id: task.messageId! },
				});
				return;
			}
		}

		if (task.type === 'gen_photo') {
			try {
				const response = (await env.AI.run('@cf/black-forest-labs/flux-1-schnell', {
					prompt: task.prompt,
				})) as { image: string };

				if (response.image) {
					const binaryString = atob(response.image);
					const bytes = new Uint8Array(binaryString.length);
					for (let i = 0; i < binaryString.length; i++) {
						bytes[i] = binaryString.charCodeAt(i);
					}
					await botInstance.api.sendPhoto(task.chatId!, new InputFile(bytes, 'photo.png'), {
						business_connection_id: task.businessConnectionId,
						reply_parameters: { message_id: task.messageId! },
					});
					return;
				}
			} catch (e) {
				console.error('[processTask] Failed to generate photo:', e);
				await botInstance.api.sendMessage(task.chatId!, 'Failed to generate photo.', {
					business_connection_id: task.businessConnectionId,
					reply_parameters: { message_id: task.messageId! },
				});
				return;
			}
		}

		const userMessage: ChatMessage = { role: 'user', content: task.prompt };
		if (task.type === 'photo' && task.fileId) {
			try {
				const file = await botInstance.api.getFile(task.fileId);
				const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
				const fileRes = await fetch(fileUrl);
				if (fileRes.ok) {
					const arrayBuffer = await fileRes.arrayBuffer();
					const base64Data = arrayBufferToBase64(arrayBuffer);
					userMessage.geminiParts = [
						{ text: task.prompt || 'Please describe this image' },
						{
							inlineData: {
								mimeType: 'image/jpeg',
								data: base64Data
							}
						}
					];
					try {
						const sandbox = getSandbox(env.Sandbox, String(task.userId));
						await sandbox.writeFile('/workspace/uploaded_image.png', base64Data);
						console.log(`[processTask] Proactively wrote uploaded_image.png to sandbox.`);
					} catch (se) {
						console.warn(`[processTask] Sandbox not bound or failed writing image:`, se);
					}
				}
			} catch (e) {
				console.error('[processTask] Failed to download image for vision task:', e);
			}
		}

		const messages = [
			{ role: 'system', content: task.systemPrompt || 'You are a helpful assistant.' },
			...(task.history || []),
			userMessage,
		];
		const modelId = task.modelId || '@cf/meta/llama-3.1-8b-instruct-fp8';

		const responseContent = await streamAiResponseToTelegram(
			{
				env,
				api: botInstance.api,
			},
			env.AI,
			modelId,
			messages,
			task,
			[
				fetchTool,
				wikipediaTool,
				createTavilySearchTool(env.TAVILY_API_KEY || ''),
				createSandboxTool(env.Sandbox, String(task.userId)),
				createTelegramFileReaderTool(env, env.Sandbox, String(task.userId), messages, modelId),
				createTelegramFileSearchTool(env, String(task.userId), modelId),
				createCodeWorkspaceTool(env, env.Sandbox, String(task.userId), botInstance.api, task),
			],
		);

		if (task.userId && responseContent) {
			const historyManager = new HistoryManager(env.CONVERSATION_HISTORY);
			await historyManager.addMessage(task.userId, task.prompt, responseContent, task.threadId);
		}
	} catch (e) {
		console.error('[processTask] Error processing task:', e);
		throw e;
	}
}

export class BotWorkflow extends WorkflowEntrypoint<Environment, Task> {
	async run(event: WorkflowEvent<Task>, step: WorkflowStep) {
		const task = event.payload;

		if (
			task.type === 'message' ||
			task.type === 'business_message' ||
			task.type === 'tool_call' ||
			task.type === 'photo' ||
			task.type === 'voice' ||
			task.type === 'gen_photo'
		) {
			await step.do('process task', {
				retries: {
					limit: 3,
					delay: '2 seconds',
					backoff: 'exponential',
				},
				timeout: '5 minutes',
			}, async () => {
				await processTask(task, this.env);
			});
		}
	}
}

const app = new Hono<{ Bindings: Environment }>();

app.onError((err, c) => {
	console.error(`[Bot Error]: ${err.message}`);
	if (err.stack) {
		console.error(`[Bot Error Stack]:\n${err.stack}`);
	}

	// Return a 200 OK to Telegram so it doesn't continuously retry
	// and spam a broken update loop into your server.
	if (c.req.method === 'POST') {
		const pathname = new URL(c.req.url).pathname;
		if (pathname !== '/verify' && pathname !== '/workflow') {
			return c.text('Internal handled', 200);
		}
	}

	return c.text('Internal Server Error', 500);
});

// Middleware to verify Telegram Webhook Secret Token if configured
app.use('*', async (c, next) => {
	if (c.req.method === 'POST') {
		const pathname = new URL(c.req.url).pathname;
		// Skip verification for /verify and /workflow API routes
		if (pathname !== '/verify' && pathname !== '/workflow') {
			const expectedSecret = c.env.SECRET_TELEGRAM_WEBHOOK;
			if (expectedSecret) {
				const receivedSecret = c.req.header('X-Telegram-Bot-Api-Secret-Token');
				if (receivedSecret !== expectedSecret) {
					console.warn('[Security] Unauthorized webhook request: secret token mismatch');
					return c.text('Unauthorized', 401);
				}
			}
		}
	}
	await next();
});

app.post('/verify', async (c) => {
	try {
		const body = await c.req.json() as { authProof?: string };
		if (body.authProof) {
			const isInitDataValid = await verifyTelegramWebAppData(body.authProof, c.env.SECRET_TELEGRAM_API_TOKEN);
			const isLoginDataValid = !isInitDataValid && await verifyTelegramLogin(body.authProof, c.env.SECRET_TELEGRAM_API_TOKEN);
			if (isInitDataValid || isLoginDataValid) {
				return c.json({ valid: true }, 200);
			}
		}
	} catch (e) {
		return c.json({ valid: false }, 401);
	}
	return c.json({ valid: false }, 401);
});

app.post('/workflow', async (c) => {
	const xTelegramAuth = c.req.header('x-telegram-auth');

	if (!xTelegramAuth) {
		return c.text('Unauthorized: Missing Telegram auth proof', 401);
	}
	
	const isInitDataValid = await verifyTelegramWebAppData(xTelegramAuth, c.env.SECRET_TELEGRAM_API_TOKEN);
	const isLoginDataValid = !isInitDataValid && await verifyTelegramLogin(xTelegramAuth, c.env.SECRET_TELEGRAM_API_TOKEN);
	
	if (!isInitDataValid && !isLoginDataValid) {
		return c.text('Unauthorized: Invalid Telegram auth proof', 401);
	}
	
	let task: Task;
	try {
		task = await c.req.json() as Task;
	} catch (e) {
		return c.text('Unauthorized: Invalid JSON', 401);
	}

	// Proactively sync user uploaded files from R2 to Sandbox /workspace/ and cleanup deleted files
	await syncUserSandboxWorkspace(String(task.userId), c.env);
	
	console.log(`[Fetch] Task type: ${task.type}, prompt: ${task.prompt}, stream: ${task.stream}`);

	const userMessage: ChatMessage = { role: 'user', content: task.prompt };
	if (task.type === 'photo' && task.fileId) {
		try {
			const api = new Bot<MyContext>(c.env.SECRET_TELEGRAM_API_TOKEN).api;
			const file = await api.getFile(task.fileId);
			if (file.file_path) {
				const fileUrl = `https://api.telegram.org/file/bot${c.env.SECRET_TELEGRAM_API_TOKEN}/${file.file_path}`;
				const fileRes = await fetch(fileUrl);
				if (fileRes.ok) {
					const arrayBuffer = await fileRes.arrayBuffer();
					const base64Data = arrayBufferToBase64(arrayBuffer);
					userMessage.geminiParts = [
						{ text: task.prompt || 'Please describe this image' },
						{
							inlineData: {
								mimeType: 'image/jpeg',
								data: base64Data
							}
						}
					];
					try {
						const sandbox = getSandbox(c.env.Sandbox, String(task.userId));
						await sandbox.writeFile('/workspace/uploaded_image.png', base64Data);
						console.log(`[Fetch] Proactively wrote uploaded_image.png to sandbox.`);
					} catch (se) {
						console.warn(`[Fetch] Sandbox not bound or failed writing image:`, se);
					}
				}
			}
		} catch (e) {
			console.error('[Fetch] Failed to download image for vision task:', e);
		}
	}

	const messages = [
		{ role: 'system', content: task.systemPrompt || 'You are a helpful assistant.' },
		...(task.history || []),
		userMessage,
	];

	const tools = [
		fetchTool,
		wikipediaTool,
		createTavilySearchTool(c.env.TAVILY_API_KEY || ''),
		createSandboxTool(c.env.Sandbox, String(task.userId)),
		createTelegramFileReaderTool(c.env, c.env.Sandbox, String(task.userId), messages, task.modelId || '@cf/meta/llama-3.1-8b-instruct-fp8'),
		createTelegramFileSearchTool(c.env, String(task.userId), task.modelId || '@cf/meta/llama-3.1-8b-instruct-fp8'),
		createCodeWorkspaceTool(c.env, c.env.Sandbox, String(task.userId), new Bot<MyContext>(c.env.SECRET_TELEGRAM_API_TOKEN).api, task),
	];

	const aiResponse = await customRunWithTools(
		c.env.AI,
		task.modelId || '@cf/meta/llama-3.1-8b-instruct-fp8',
		{ messages, tools: task.type === 'tool_call' ? tools : [] },
		{ streamFinalResponse: task.stream || false },
	);

	console.log(`[Fetch] aiResponse type: ${typeof aiResponse}, constructor: ${aiResponse && typeof aiResponse === 'object' ? aiResponse.constructor?.name : 'unknown'}`);

	let stream: ReadableStream | null = null;
	if (aiResponse instanceof ReadableStream) {
		stream = aiResponse;
	} else if (aiResponse && typeof aiResponse === 'object' && 'body' in aiResponse && aiResponse.body instanceof ReadableStream) {
		stream = aiResponse.body;
	} else if (aiResponse && typeof aiResponse === 'object' && 'getReader' in aiResponse && typeof aiResponse.getReader === 'function') {
		stream = aiResponse as unknown as ReadableStream;
	}

	if (task.stream && stream) {
		console.log(`[Fetch] Returning streaming response. Locked: ${stream.locked}`);
		return new Response(stream, {
			headers: { 'Content-Type': 'text/event-stream' },
		});
	}

	console.log('[Fetch] Returning JSON response');
	return c.json(aiResponse);
});

app.all('*', async (c) => {
	const url = new URL(c.req.url);
	const method = c.req.method;

	if (method === 'GET' && c.req.query('command') === 'set') {
		const token = c.env.SECRET_TELEGRAM_API_TOKEN;
		const webhookUrl = `${url.origin}${url.pathname}`;
		const api = new Bot<MyContext>(token).api;

		try {
			const result = await api.setWebhook(webhookUrl, {
				max_connections: 40,
				allowed_updates: [
					'message',
					'edited_message',
					'callback_query',
					'guest_message',
					'business_message',
					'business_connection',
					'pre_checkout_query',
				],
				drop_pending_updates: true,
				secret_token: c.env.SECRET_TELEGRAM_WEBHOOK,
			});
			return c.json({ ok: result });
		} catch (e: any) {
			return c.json({ ok: false, error: e.message }, 500);
		}
	}

	if (method === 'POST') {
		const token = c.env.SECRET_TELEGRAM_API_TOKEN;
		if (!token) {
			console.error('[Fetch] SECRET_TELEGRAM_API_TOKEN is empty or undefined!');
			return c.text('Error: SECRET_TELEGRAM_API_TOKEN is missing', 500);
		}
		const bot = new Bot<MyContext>(token);
		setupBot(bot, c.env, c.executionCtx);

		const clone = c.req.raw.clone();
		try {
			const body = await clone.json();
			console.log('[Fetch] Incoming Update:', JSON.stringify(body));
		} catch (e) {
			console.error('[Fetch] Error parsing update body:', e);
		}

		try {
			return await webhookCallback(bot, 'hono', {
				timeoutMilliseconds: 15_000,
				onTimeout: 'return',
			})(c);
		} catch (e: any) {
			console.error('[Fetch-Webhook-Error] Error during webhook update handling:', e);
			if (e instanceof GrammyError) {
				console.error(`[Fetch-Webhook-Error] GrammyError: ${e.method}, Error Code: ${e.error_code}, Description: ${e.description}`);
			} else if (e instanceof HttpError) {
				console.error(`[Fetch-Webhook-Error] HttpError: Could not contact Telegram API.`, e);
			} else if (e instanceof Error) {
				console.error(`[Fetch-Webhook-Error] Stack trace:\n${e.stack}`);
			}
			return c.text('Internal Webhook Error Handled', 200);
		}
	}

	return c.text('OK');
});

export default app;
