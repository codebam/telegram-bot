import { Bot, Context, webhookCallback, session } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { stream, type StreamFlavor } from '@grammyjs/stream';
import { CommandGroup, type CommandsFlavor } from '@grammyjs/commands';
import { conversations, createConversation, type Conversation, type ConversationFlavor } from '@grammyjs/conversations';
import { KvAdapter } from '@grammyjs/storage-cloudflare';
import type { KVNamespace as CfKVNamespace } from '@cloudflare/workers-types';
import { HistoryManager, getBalance, markdownToHtml, SYSTEM_PROMPTS, AVAILABLE_MODELS, type Task, type Environment } from '@codebam/shared';
import { fetchTool, wikipediaTool, createTavilySearchTool, createSandboxTool } from './lib/utils.js';
import { streamAiResponseToTelegram, customRunWithTools } from './lib/ai.js';

export { Sandbox } from '@cloudflare/sandbox';

type BaseContext = CommandsFlavor &
	Context & {
		env: Environment;
		executionCtx: ExecutionContext;
		session: Record<string, unknown>;
	};

type MyContext = StreamFlavor<BaseContext & ConversationFlavor<BaseContext>>;

type MyConversation = Conversation<MyContext, MyContext>;

async function getBusinessOwnerData(
	ctx: Context,
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
			const response = await fetch(`https://api.telegram.org/bot${env.SECRET_TELEGRAM_API_TOKEN}/getBusinessConnection?business_connection_id=${connectionId}`);
			console.log(`[getBusinessOwnerData] Telegram API response status: ${response.status}`);
			if (response.status === 200) {
				const json = (await response.json()) as {
					ok: boolean;
					result?: {
						user?: { first_name: string; username?: string; id: number };
						user_chat_id?: number;
					};
				};
				console.log(`[getBusinessOwnerData] Telegram API returned JSON:`, JSON.stringify(json));
				if (json.ok && json.result) {
					const id = json.result.user?.id || json.result.user_chat_id;
					const name = json.result.user?.first_name || 'the business owner';
					const username = json.result.user?.username;
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
						console.error(`[getBusinessOwnerData] Failed to resolve owner ID from result:`, JSON.stringify(json.result));
					}
				} else {
					console.error(`[getBusinessOwnerData] Telegram API returned ok=false or missing result:`, JSON.stringify(json));
				}
			} else {
				console.error(`[getBusinessOwnerData] Telegram API call failed. Status: ${response.status}`);
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

	if (ctx.update.business_message) {
		const connectionId = ctx.update.business_message?.business_connection_id;
		const customerId = ctx.update.business_message?.chat.id;
		if (connectionId && customerId) {
			userId = `business:${connectionId}:${customerId}`;
			const ownerData = await getBusinessOwnerData(ctx, ctx.env, connectionId);
			if (ownerData?.id) {
				billingUserId = ownerData.id;
			}
		}
	}

	if (!userId || userId === ctx.me.id) {
		console.log(`Skipping chargeStars: userId=${userId}, botId=${ctx.me.id}`);
		return;
	}

	task.userId = userId;
	task.senderId = ctx.from?.id || ctx.update.guest_message?.from?.id;
	task.chatId = ctx.chat?.id.toString() || ctx.update.guest_message?.chat?.id?.toString();
	task.updateId = ctx.update.update_id;
	task.messageId =
		ctx.message?.message_id ??
		ctx.update.business_message?.message_id ??
		ctx.update.guest_message?.message_id;
	task.updateType = Object.keys(ctx.update).find((k) => k !== 'update_id');
	task.guestQueryId = ctx.update.guest_message?.guest_query_id;
	task.businessConnectionId = ctx.update.business_message?.business_connection_id?.toString();
	task.threadId = ctx.message?.message_thread_id ?? ctx.update.business_message?.message_thread_id ?? ctx.update.guest_message?.message_thread_id;
	
	const balanceKey = `balance:${String(billingUserId)}`;
	const balance = await getBalance(billingUserId || 0, ctx.env.CONVERSATION_HISTORY);

	const modelPreference =
		(await ctx.env.CONVERSATION_HISTORY.get<string>(`model:${String(billingUserId)}`)) ?? 'gemma4';
	const modelConfig = AVAILABLE_MODELS[modelPreference] ?? AVAILABLE_MODELS.gemma4;

	if (task.type === 'tool_call' && !modelConfig.supportsTools) {
		task.modelId = AVAILABLE_MODELS.gemma4.id;
	} else {
		task.modelId = modelConfig.id;
	}

	const amount = amountOverride ?? modelConfig.cost;

	if (balance >= amount) {
		try {
			await ctx.replyWithChatAction('typing', {
				business_connection_id: ctx.update.business_message?.business_connection_id,
			});
		} catch (e) {
			console.log('[chargeStars] Failed to send chat action (likely not a member):', e);
		}
		await ctx.env.CONVERSATION_HISTORY.put(balanceKey, JSON.stringify(balance - amount));
		task.telegramToken = ctx.env.SECRET_TELEGRAM_API_TOKEN;

		if (ctx.update.business_message) {
			if (!task.systemPrompt) {
				let prompt = SYSTEM_PROMPTS.BUSINESS_MODE;
				const connectionId = ctx.update.business_message?.business_connection_id;
				if (connectionId) {
					const ownerData = await getBusinessOwnerData(ctx, ctx.env, connectionId);
					if (ownerData) {
						prompt = prompt.replace(/{owner_name}/g, ownerData.name);
						const facts = await ctx.env.CONVERSATION_HISTORY.get(`business_facts:${String(ownerData.id)}`);
						if (facts) {
							prompt += `\n\nHere are some facts about you:\n${facts}`;
						}
					}
				}
				task.systemPrompt = prompt;
			}
		}
 else {
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

		ctx.executionCtx.waitUntil(
			ctx.env.MESSAGE_QUEUE.send(task).catch(console.error)
		);
	} else {
		if (ctx.update.business_message || ctx.update.guest_message) {
			await ctx.reply(
				'Insufficient balance. Please go to direct messages and use /load to top up your Stars.',
				{
					business_connection_id: ctx.update.business_message?.business_connection_id,
					reply_to_message_id: ctx.update.business_message?.message_id,
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
		const threadId = ctx.message?.message_thread_id || ctx.update.business_message?.message_thread_id;

		if (ctx.update.business_message) {
			const connectionId = ctx.update.business_message?.business_connection_id;
			const customerId = ctx.update.business_message?.chat.id;
			if (connectionId && customerId) {
				userId = `business:${connectionId}:${customerId}`;
			}
		}

		// Initialize history from KV if it exists, otherwise start fresh
		const history = (await conversation.external(async () => {
			const historyManager = new HistoryManager(env.CONVERSATION_HISTORY);
			return await historyManager.getHistory(userId, threadId);
		})) || [];

		while (true) {
			let prompt = ctx.message?.text || ctx.message?.caption || ctx.update.business_message?.text || ctx.update.business_message?.caption || '';

			const replyToMessage = ctx.message?.reply_to_message || ctx.update.business_message?.reply_to_message;
			if (replyToMessage) {
				const replyText = replyToMessage.text || replyToMessage.caption || '';
				if (replyText) {
					prompt = `Context of the message I am replying to: "${replyText}"\n\nMy message: ${prompt}`;
				}
			}

			if (prompt) {
				// Logic from chargeStars but integrated into the conversation
				let billingUserId = ctx.from?.id;
				let ownerData: { id: number; name: string; username?: string } | null = null;
				if (ctx.update.business_message) {
					const connectionId = ctx.update.business_message?.business_connection_id;
					if (connectionId) {
						ownerData = await conversation.external(() => getBusinessOwnerData(ctx, env, connectionId));
						if (ownerData?.id) {
							billingUserId = ownerData.id;
						}
					}
				}

				const { balance, modelPreference } = await conversation.external(async () => {
					const b = await getBalance(billingUserId || 0, env.CONVERSATION_HISTORY);
					const mp = (await env.CONVERSATION_HISTORY.get<string>(`model:${String(billingUserId)}`)) ?? 'gemma4';
					return { balance: b, modelPreference: mp };
				});

				const modelConfig = AVAILABLE_MODELS[modelPreference] ?? AVAILABLE_MODELS.gemma4;
				const amount = modelConfig.cost;

				if (balance >= amount) {
					try {
						await ctx.replyWithChatAction('typing', {
							business_connection_id: ctx.update.business_message?.business_connection_id,
						});
					} catch (e) {
						console.error('[chatConversation] Failed to send chat action:', e);
					}
					const balanceKey = `balance:${String(billingUserId)}`;
					await conversation.external(() => env.CONVERSATION_HISTORY.put(balanceKey, JSON.stringify(balance - amount)));

					const systemPrompt = await conversation.external(async () => {
						if (ctx.update.business_message) {
							let prompt = SYSTEM_PROMPTS.BUSINESS_MODE;
							if (ownerData) {
								prompt = prompt.replace(/{owner_name}/g, ownerData.name);
								const facts = await env.CONVERSATION_HISTORY.get(`business_facts:${String(ownerData.id)}`);
								if (facts) {
									prompt += `\n\nHere are some facts about you:\n${facts}`;
								}
							}
							return prompt;
						}
						const customPrompt = await env.CONVERSATION_HISTORY.get(`prompt:${String(userId)}`);
						return customPrompt || SYSTEM_PROMPTS.TUX_ROBOT;
					});

					const messages = [
						{ role: 'system', content: systemPrompt },
						...history,
						{ role: 'user', content: prompt },
					];

					const modelId = modelConfig.id;

					const responseContent = await streamAiResponseToTelegram(
						ctx,
						env.AI,
						modelId,
						messages,
						{
							type: ctx.update.business_message ? 'business_message' : 'message',
							updateType: ctx.update.business_message ? 'business_message' : 'message',
							prompt,
							chatId: ctx.chat?.id.toString(),
							threadId,
							businessConnectionId: ctx.update.business_message?.business_connection_id?.toString(),
							messageId: ctx.message?.message_id || ctx.update.business_message?.message_id,
							userId: String(userId),
							systemPrompt,
							history,
							telegramToken: env.SECRET_TELEGRAM_API_TOKEN,
						},
						[
							fetchTool,
							wikipediaTool,
							createTavilySearchTool(env.TAVILY_API_KEY || ''),
							createSandboxTool(env.Sandbox, String(userId)),
						],
					);

					if (responseContent) {
						history.push({ role: 'user', content: prompt });
						history.push({ role: 'assistant', content: responseContent });
						// Sync back to KV
						await conversation.external(() => new HistoryManager(env.CONVERSATION_HISTORY).addMessage(userId, prompt, responseContent, threadId));
					}
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
		ctx.env = env;
		ctx.executionCtx = executionCtx;
		await next();
	});

	bot.api.config.use(autoRetry());
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
		await ctx.reply(
			'Welcome! Here are my commands:\n' +
				'/balance - Check your current Star balance\n' +
				'/load <amount> - Top up your balance with Telegram Stars\n' +
				'/photo <prompt> - Generate an image (100 Stars)\n' +
				'/model <name> - Switch AI model and see costs\n' +
				'/ttl <1-5> - Set the TTL for bot-to-bot responses\n' +
				'/code <prompt> - Generate code snippets\n' +
				'/prompt <"prompt"> - Set your custom system prompt (use "" or reset to clear)\n' +
				'/facts <"facts"> - Set facts about yourself for business mode (use "" or reset to clear)\n' +
				'/request <prompt> - Make arbitrary API requests (uses fetch tool)\n' +
				'<prompt> - Generate text (may use tools if supported by model)\n' +
				'Send a voice note - Transform your bot into a voice assistant (+20 Stars)\n' +
				'/clear - Clear your conversation history\n\n' +
				'New users start with 200 free credits!\n\n' +
				'Click the button below to open the Web App!',
			{
				reply_markup: {
					inline_keyboard: [[{ text: 'Open Web App', web_app: { url: 'https://tux-robot.codebam.ca' } }]],
				},
			},
		);
	});

	commands.command('balance', 'Check your current Star balance', async (ctx) => {
		if (ctx.from) {
			const balance = await getBalance(ctx.from.id, ctx.env.CONVERSATION_HISTORY);
			await ctx.reply(`Your current balance is ${String(balance)} Stars.`);
		}
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

	commands.command('clear', 'Clear your conversation history', async (ctx) => {
		if (ctx.from) {
			const historyManager = new HistoryManager(ctx.env.CONVERSATION_HISTORY);
			let historyUserId: number | string = ctx.from.id;
			if (ctx.update.business_message) {
				const connectionId = ctx.update.business_message?.business_connection_id;
				const customerId = ctx.update.business_message?.chat.id;
				if (connectionId && customerId) {
					historyUserId = `business:${connectionId}:${customerId}`;
				}
			}
			const threadId = ctx.message?.message_thread_id ?? ctx.update.guest_message?.message_thread_id;
			await historyManager.clearHistory(historyUserId, threadId);
			await ctx.reply('History cleared');
		}
	});

	commands.command('code', 'Generate code snippets', async (ctx) => {
		const prompt = ctx.match;
		if (prompt) {
			await chargeStars(ctx, { type: 'code', prompt });
		}
	});

	commands.command('ttl', 'Set the TTL for bot-to-bot responses', async (ctx) => {
		const newTtl = parseInt(ctx.match || '0');
		const token = ctx.env.SECRET_TELEGRAM_API_TOKEN;
		if (newTtl >= 1 && newTtl <= 5) {
			await ctx.env.CONVERSATION_HISTORY.put(`ttl:${token.slice(0, 10)}`, JSON.stringify(newTtl));
			await ctx.reply(`TTL set to ${newTtl}`);
		} else {
			const currentTtl = (await ctx.env.CONVERSATION_HISTORY.get<number>(`ttl:${token.slice(0, 10)}`, 'json')) ?? 2;
			await ctx.reply(`Invalid TTL. Please use a value between 1 and 5. Current TTL: ${currentTtl}`);
		}
	});

	commands.command('model', 'Switch AI model and see costs', async (ctx) => {
		if (ctx.from) {
			const modelKey = `model:${String(ctx.from.id)}`;
			const selectedModel = ctx.match?.toLowerCase();
			if (selectedModel) {
				if (selectedModel in AVAILABLE_MODELS) {
					await ctx.env.CONVERSATION_HISTORY.put(modelKey, selectedModel);
					await ctx.reply(`Model updated to <b>${selectedModel}</b>.`, { parse_mode: 'HTML' });
				} else {
					await ctx.reply(`Invalid model. Available models:\n${Object.keys(AVAILABLE_MODELS).join('\n')}`);
				}
			} else {
				const currentModel = (await ctx.env.CONVERSATION_HISTORY.get<string>(modelKey)) ?? 'gemma4';
				await ctx.reply(
					`Current model: <b>${currentModel}</b>\n\n` +
						`Available models:\n` +
						Object.entries(AVAILABLE_MODELS)
							.map(([name, cfg]) => `- <code>${name}</code> (${String(cfg.cost)} Stars)`)
							.join('\n'),
					{ parse_mode: 'HTML' },
				);
			}
		}
	});

	commands.command('prompt', 'Set your custom system prompt', async (ctx) => {
		if (ctx.from) {
			let promptValue = ctx.match.trim();
			if (promptValue === 'reset' || promptValue === '""' || promptValue === "''" || promptValue === '') {
				await ctx.env.CONVERSATION_HISTORY.delete(`prompt:${String(ctx.from.id)}`);
				await ctx.reply('System prompt reset to default.');
			} else {
				if (
					(promptValue.startsWith('"') && promptValue.endsWith('"')) ||
					(promptValue.startsWith("'") && promptValue.endsWith("'"))
				) {
					promptValue = promptValue.substring(1, promptValue.length - 1);
				}
				await ctx.env.CONVERSATION_HISTORY.put(`prompt:${String(ctx.from.id)}`, promptValue);
				await ctx.reply(`System prompt updated to:\n\n${promptValue}`);
			}
		}
	});

	commands.command('facts', 'Set facts about yourself for business mode', async (ctx) => {
		if (ctx.from) {
			let factsValue = ctx.match.trim();
			const userId = ctx.from.id;
			if (factsValue === 'reset' || factsValue === '""' || factsValue === "''" || factsValue === '') {
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
		}
	});

	commands.command('request', 'Make arbitrary API requests', async (ctx) => {
		const prompt = ctx.match;
		if (!prompt) {
			await ctx.reply('Please provide a request. Example: /request what is the weather in San Francisco?');
			return;
		}
		await chargeStars(ctx, {
			type: 'tool_call',
			prompt,
			tools: [fetchTool, wikipediaTool, createSandboxTool(ctx.env.Sandbox, String(ctx.from?.id))],
		});
	});

	bot.use(commands);

	bot.on('message:document', async (ctx) => {
		const fileId = ctx.message.document.file_id;
		const file = await ctx.api.getFile(fileId);
		const fileUrl = `https://api.telegram.org/file/bot${ctx.env.SECRET_TELEGRAM_API_TOKEN}/${file.file_path}`;
		const fileResponse = await fetch(fileUrl);
		const id = crypto.randomUUID().slice(0, 5);
		await ctx.env.R2.put(id, await fileResponse.arrayBuffer());
		await ctx.reply(`https://r2.seanbehan.ca/${id}`);
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
			const balance = (await ctx.env.CONVERSATION_HISTORY.get<number>(balanceKey, 'json')) ?? 0;
			await ctx.env.CONVERSATION_HISTORY.put(balanceKey, JSON.stringify(balance + amount));
			await ctx.reply(`Successfully loaded ${String(amount)} Stars! New balance: ${String(balance + amount)} Stars.`);
			return;
		}

		const taskId = payload;
		const task = await ctx.env.CONVERSATION_HISTORY.get<Task>(`task:${taskId}`, 'json');
		if (!task) {
			await ctx.reply('Error: Task not found');
			return;
		}
		task.telegramToken = ctx.env.SECRET_TELEGRAM_API_TOKEN;
		ctx.executionCtx.waitUntil(ctx.env.MESSAGE_QUEUE.send(task).catch(console.error));
		await ctx.env.CONVERSATION_HISTORY.delete(`task:${taskId}`);
	});

	bot.on('message:photo', async (ctx) => {
		const photo = ctx.message.photo;
		const fileId = photo[photo.length - 1].file_id;
		const prompt = ctx.message.caption ?? 'Please describe this image';
		await chargeStars(ctx, { type: 'photo', prompt, fileId }, 10);
	});

	bot.on('message:voice', async (ctx) => {
		const fileId = ctx.message.voice.file_id;
		await chargeStars(ctx, { type: 'voice', prompt: '', fileId });
	});

	bot.on('inline_query', async (ctx) => {
		const query = ctx.inlineQuery.query;
		if (!query.endsWith('.') && !query.endsWith('?')) {
			await ctx.answerInlineQuery([
				{
					type: 'article',
					id: 'complete_sentence',
					title: 'Please complete your sentence',
					input_message_content: {
						message_text: 'End your sentence with a period (.) or question mark (?) to get an AI response',
						parse_mode: 'HTML',
					},
				},
			]);
			return;
		}
		const messages = [
			{ role: 'system', content: SYSTEM_PROMPTS.TUX_ROBOT },
			{ role: 'user', content: query },
		];
		try {
			const rawResponse = await ctx.env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
				messages,
				max_completion_tokens: 100,
			});
			const aiResponse = rawResponse as { response?: string };
			if (aiResponse.response) {
				await ctx.answerInlineQuery([
					{
						type: 'article',
						id: 'ai_response',
						title: 'AI Response',
						input_message_content: {
							message_text: await markdownToHtml(aiResponse.response),
							parse_mode: 'HTML',
						},
					},
				]);
			}
		} catch {
			/* ignore */
		}
	});

	bot.on('business_connection', async (ctx) => {
		const connection = ctx.update.business_connection;
		if (connection) {
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
		}
	});

	bot.on('business_message', async (ctx) => {
		await ctx.conversation.enter('chatConversation');
	});

	bot.on('message:text', async (ctx) => {
		await ctx.conversation.enter('chatConversation');
	});

	bot.on('guest_message', async (ctx) => {
		const guestMessage = ctx.update.guest_message;
		let prompt = guestMessage.text?.toString() ?? '';
		const token = ctx.env.SECRET_TELEGRAM_API_TOKEN;
		let botUsername = await ctx.env.CONVERSATION_HISTORY.get(`bot_username:${token.slice(0, 10)}`);
		if (!botUsername) {
			const me = await ctx.api.getMe();
			botUsername = me.username;
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
				await ctx.api.answerGuestQuery(guestMessage.guest_query_id, {
					type: 'article',
					id: crypto.randomUUID(),
					title: 'Welcome',
					input_message_content: {
						message_text:
							'Welcome! Here are my commands:\n' +
							'/balance - Check your current Star balance\n' +
							'/load <amount> - Top up your balance with Telegram Stars\n' +
							'/photo <prompt> - Generate an image (100 Stars)\n' +
							'/model <name> - Switch AI model and see costs\n' +
							'/ttl <1-5> - Set the TTL for bot-to-bot responses\n' +
							'/code <prompt> - Generate code snippets\n' +
							'/prompt <"prompt"> - Set your custom system prompt (use "" or reset to clear)\n' +
							'/facts <"facts"> - Set facts about yourself for business mode (use "" or reset to clear)\n' +
							'/request <prompt> - Make arbitrary API requests (uses fetch tool)\n' +
							'<prompt> - Generate text (may use tools if supported by model)\n' +
							'Send a voice note - Transform your bot into a voice assistant (+20 Stars)\n' +
							'/clear - Clear your conversation history\n\n' +
							'New users start with 200 free credits!\n\n' +
							'Click the button below to open the Web App!',
					},
					reply_markup: {
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
}

export default {
	async queue(batch: MessageBatch<Task>, env: Environment): Promise<void> {
		for (const message of batch.messages) {
			const task = message.body;
			try {
				const messages = [
					{ role: 'system', content: task.systemPrompt || 'You are a helpful assistant.' },
					...(task.history || []),
					{ role: 'user', content: task.prompt },
				];
				const modelId = task.modelId || '@cf/meta/llama-3.1-8b-instruct-fp8';

				const token = env.SECRET_TELEGRAM_API_TOKEN;
				if (!token) {
					throw new Error('SECRET_TELEGRAM_API_TOKEN is empty in queue handler');
				}
				const botInstance = new Bot<MyContext>(token);
				botInstance.api.config.use(autoRetry());

				const responseContent = await streamAiResponseToTelegram(
					{
						env,
						api: botInstance.api,
						reply: (text: string, options: Parameters<typeof botInstance.api.sendMessage>[2]) =>
							botInstance.api.sendMessage(task.chatId!, text, options),
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
					],
				);

				if (task.userId && responseContent) {
					const historyManager = new HistoryManager(env.CONVERSATION_HISTORY);
					await historyManager.addMessage(task.userId, task.prompt, responseContent, task.threadId);
				}
			} catch (e) {
				console.error('[Queue] Error processing message:', e);
				message.retry();
			}
		}
	},
	async fetch(request: Request, env: Environment, executionCtx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const xSource = request.headers.get('x-source');
		const xPassword = request.headers.get('x-password');
		console.log(`[Fetch] Incoming request: ${request.method} ${url.href} (hostname: ${url.hostname}, source: ${xSource})`);

		if (url.hostname === 'workflow.local' || url.pathname === '/workflow' || xSource === 'webapp') {
			if (xPassword !== env.SECRET_TELEGRAM_API_TOKEN) {
				return new Response('Unauthorized', { status: 401 });
			}
			console.log('[Fetch] Matches task endpoint, processing task...');
			const task = (await request.json()) as Task;
			console.log(`[Fetch] Task type: ${task.type}, prompt: ${task.prompt}, stream: ${task.stream}`);

			const messages = [
				{ role: 'system', content: task.systemPrompt || 'You are a helpful assistant.' },
				...(task.history || []),
				{ role: 'user', content: task.prompt },
			];

			const tools = [
				fetchTool,
				wikipediaTool,
				createTavilySearchTool(env.TAVILY_API_KEY || ''),
				createSandboxTool(env.Sandbox, String(task.userId)),
			];

			const aiResponse = await customRunWithTools(
				env.AI,
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
			return new Response(JSON.stringify(aiResponse), {
				headers: { 'Content-Type': 'application/json' },
			});
		}

		const token = env.SECRET_TELEGRAM_API_TOKEN;
		if (!token) {
			console.error('[Fetch] SECRET_TELEGRAM_API_TOKEN is empty or undefined!');
			return new Response('Error: SECRET_TELEGRAM_API_TOKEN is missing', { status: 500 });
		}
		const bot = new Bot<MyContext>(token);
		setupBot(bot, env, executionCtx);

		if (request.method === 'POST') {
			const clone = request.clone();
			try {
				const body = await clone.json();
				console.log('[Fetch] Incoming Update:', JSON.stringify(body));
			} catch (e) {
				console.error('[Fetch] Error parsing update body:', e);
			}
		}

		if (request.method === 'GET') {
			const url = new URL(request.url);
			if (url.searchParams.get('command') === 'set') {
				const token = env.SECRET_TELEGRAM_API_TOKEN;
				const webhookUrl = `${url.origin}${url.pathname}`;
				const telegramUrl = `https://api.telegram.org/bot${token}/setWebhook`;

				const params = new URLSearchParams({
					url: webhookUrl,
					max_connections: '40',
					allowed_updates: JSON.stringify([
						'message',
						'edited_message',
						'callback_query',
						'inline_query',
						'guest_message',
						'business_message',
						'business_connection',
						'pre_checkout_query',
					]),
					drop_pending_updates: 'true',
				});

				const res = await fetch(`${telegramUrl}?${params.toString()}`);
				return new Response(JSON.stringify(await res.json()), {
					headers: { 'Content-Type': 'application/json' },
					status: res.status,
				});
			}
		}
		return webhookCallback(bot, 'cloudflare-mod', {
			onTimeout: 'return',
		})(request);
		},
		};
