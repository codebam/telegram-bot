import { Bot, Context, webhookCallback } from 'grammy';
import { HistoryManager, getBalance, markdownToHtml, SYSTEM_PROMPTS, AVAILABLE_MODELS, type Task, type Environment } from '@codebam/shared';
import { fetchTool, wikipediaTool, createTavilySearchTool } from './lib/utils.js';
import { streamAiResponseToTelegram, customRunWithTools } from './lib/ai.js';

type MyContext = Context & {
	env: Environment;
	executionCtx: ExecutionContext;
};

async function getBusinessOwnerData(
	ctx: MyContext,
	connectionId: string
): Promise<{ id: number; name: string; username?: string } | null> {
	let ownerData = await ctx.env.CONVERSATION_HISTORY.get<{ id: number; name: string; username?: string }>(
		`business_connection:${connectionId}`,
		'json'
	);
	if (ownerData && ownerData.username !== undefined) {
		console.log(`[getBusinessOwnerData] Cache HIT for connection ${connectionId}:`, JSON.stringify(ownerData));
	} else {
		console.log(`[getBusinessOwnerData] Cache MISS or stale entry for connection ${connectionId}. Fetching from Telegram API...`);
		try {
			const response = await fetch(`https://api.telegram.org/bot${ctx.env.SECRET_TELEGRAM_API_TOKEN}/getBusinessConnection?business_connection_id=${connectionId}`);
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
						await ctx.env.CONVERSATION_HISTORY.put(
							`active_connection:${id}`,
							connectionId
						);
						await ctx.env.CONVERSATION_HISTORY.put(
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
			const ownerData = await getBusinessOwnerData(ctx, connectionId);
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
	task.threadId = ctx.message?.message_thread_id ?? ctx.update.guest_message?.message_thread_id;
	
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
			await ctx.replyWithChatAction('typing');
		} catch (e) {
			console.log('[chargeStars] Failed to send chat action (likely not a member):', e);
		}
		await ctx.env.CONVERSATION_HISTORY.put(balanceKey, JSON.stringify(balance - amount));
		task.telegramToken = ctx.env.SECRET_TELEGRAM_API_TOKEN;

		if (ctx.update.business_message) {
			if (!task.systemPrompt) {
				task.systemPrompt = SYSTEM_PROMPTS.BUSINESS_MODE;
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

		ctx.executionCtx.waitUntil(
			ctx.env.MESSAGE_QUEUE.send(task).catch(console.error)
		);
	} else {
		if (ctx.update.business_message || ctx.update.guest_message) {
			await ctx.reply(
				'Insufficient balance. Please go to direct messages and use /load to top up your Stars.'
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

function setupBot(bot: Bot<MyContext>, env: Environment, executionCtx: ExecutionContext) {
	bot.use(async (ctx, next) => {
		ctx.env = env;
		ctx.executionCtx = executionCtx;
		await next();
	});

	bot.use(async (ctx, next) => {
		const token = ctx.env.SECRET_TELEGRAM_API_TOKEN;
		const botTtl = (await ctx.env.CONVERSATION_HISTORY.get<number>(`ttl:${token.slice(0, 10)}`, 'json')) ?? 2;

		const isSelf = ctx.from?.id === ctx.me.id;
		const counterKey = `ttl_counter:${ctx.chat?.id}:${token.slice(0, 10)}`;

		if (isSelf) {
			const count = (await ctx.env.CONVERSATION_HISTORY.get<number>(counterKey, 'json')) ?? 0;
			if (count >= botTtl) {
				console.log(`TTL exceeded for chat ${ctx.chat?.id}. Blocking update.`);
				return;
			}
			await ctx.env.CONVERSATION_HISTORY.put(counterKey, JSON.stringify(count + 1), {
				expirationTtl: 3600,
			});
		} else {
			await ctx.env.CONVERSATION_HISTORY.delete(counterKey);
		}
		await next();
	});

	bot.command('start', async (ctx) => {
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

	bot.command('balance', async (ctx) => {
		if (ctx.from) {
			const balance = await getBalance(ctx.from.id, ctx.env.CONVERSATION_HISTORY);
			await ctx.reply(`Your current balance is ${String(balance)} Stars.`);
		}
	});

	bot.command('load', async (ctx) => {
		const amount = parseInt(ctx.match || '0');
		if (isNaN(amount) || amount <= 0 || amount > 1000) {
			await ctx.reply('Please specify an amount between 1 and 1000 Stars. Example: /load 100');
		} else {
			await ctx.replyWithInvoice('Stars Top-up', `Purchase ${String(amount)} Stars`, `load:${String(amount)}`, 'XTR', [
				{ label: 'Stars', amount },
			]);
		}
	});

	bot.command('clear', async (ctx) => {
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

	bot.command('code', async (ctx) => {
		const prompt = ctx.match;
		if (prompt) {
			await chargeStars(ctx, { type: 'code', prompt });
		}
	});

	bot.command('ttl', async (ctx) => {
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

	bot.command('model', async (ctx) => {
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

	bot.command('prompt', async (ctx) => {
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

	bot.command('facts', async (ctx) => {
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

	bot.command('request', async (ctx) => {
		const prompt = ctx.match;
		if (!prompt) {
			await ctx.reply('Please provide a request. Example: /request what is the weather in San Francisco?');
			return;
		}
		await chargeStars(ctx, { type: 'tool_call', prompt, tools: [fetchTool, wikipediaTool] });
	});

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
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const rawResponse = await ctx.env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct' as any, {
				messages,
				max_completion_tokens: 100,
			});
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const aiResponse = rawResponse as any;
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
		await ctx.replyWithChatAction('typing');
		const businessMessage = ctx.update.business_message!;
		const photo = businessMessage.photo;
		const fileId = photo ? photo[photo.length - 1].file_id : '';
		let prompt = businessMessage.text ?? businessMessage.caption ?? '';
		if (businessMessage.reply_to_message) {
			const reply = businessMessage.reply_to_message;
			const replyText = reply.text ?? reply.caption ?? '';
			if (replyText) {
				prompt = `Context of the message I am replying to: "${replyText}"\n\nMy message: ${prompt}`;
			}
		}

		let ownerName = 'the business owner';
		let ownerId: number | undefined;
		let username: string | undefined;
		const connectionId = businessMessage.business_connection_id;
		if (connectionId) {
			const ownerData = await getBusinessOwnerData(ctx, connectionId);
			if (ownerData) {
				ownerName = ownerData.name;
				ownerId = ownerData.id;
				username = ownerData.username;
			}
		}

		let systemPrompt = SYSTEM_PROMPTS.BUSINESS_MODE.replaceAll('{owner_name}', ownerName);
		let facts: string | null = null;
		if (ownerId) {
			facts = await ctx.env.CONVERSATION_HISTORY.get(`business_facts:${String(ownerId)}`);
		}
		if (!facts && username) {
			facts = await ctx.env.CONVERSATION_HISTORY.get(`business_facts:${username}`);
		}
		if (!facts && ownerName && ownerName !== 'the business owner') {
			facts = await ctx.env.CONVERSATION_HISTORY.get(`business_facts:${ownerName}`);
		}

		if (facts) {
			systemPrompt += `\n\nHere are some facts about yourself (${ownerName}) that you should keep in mind and use to answer accurately if relevant:\n${facts}`;
		}

		await chargeStars(ctx, {
			type: 'business_message',
			prompt,
			fileId,
			systemPrompt,
		});
	});

	bot.on('message:text', async (ctx) => {
		// Regular message logic
		let prompt = ctx.message.text;
		if (ctx.message.reply_to_message) {
			const reply = ctx.message.reply_to_message;
			const replyText = reply.text ?? reply.caption ?? '';
			if (replyText) {
				prompt = `Context of the message I am replying to: "${replyText}"\n\nMy message: ${prompt}`;
			}
		}
		await chargeStars(ctx, { type: 'message', prompt });
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

				const responseContent = await streamAiResponseToTelegram(
					{
						env,
						api: botInstance.api,
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						reply: (text: string, options: any) => botInstance.api.sendMessage(task.chatId!, text, options),
					},
					env.AI,
					modelId,
					messages,
					task,
					[fetchTool, wikipediaTool, createTavilySearchTool(env.TAVILY_API_KEY || '')],
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
		console.log(`[Fetch] Incoming request: ${request.method} ${url.href} (hostname: ${url.hostname}, source: ${xSource})`);

		if (url.hostname === 'workflow.local' || url.pathname === '/workflow' || xSource === 'webapp') {
			console.log('[Fetch] Matches task endpoint, processing task...');
			const task = (await request.json()) as Task;
			console.log(`[Fetch] Task type: ${task.type}, prompt: ${task.prompt}, stream: ${task.stream}`);

			const messages = [
				{ role: 'system', content: task.systemPrompt || 'You are a helpful assistant.' },
				...(task.history || []),
				{ role: 'user', content: task.prompt },
			];

			const tools = [fetchTool, wikipediaTool, createTavilySearchTool(env.TAVILY_API_KEY || '')];

			const aiResponse = (await customRunWithTools(
				env.AI,
				task.modelId || '@cf/meta/llama-3.1-8b-instruct-fp8',
				{ messages, tools: task.type === 'tool_call' ? tools : [] },
				{ streamFinalResponse: task.stream || false },
			)) as any;

			console.log(`[Fetch] aiResponse type: ${typeof aiResponse}, constructor: ${aiResponse?.constructor?.name}`);

			let stream = null;
			if (aiResponse instanceof ReadableStream) {
				stream = aiResponse;
			} else if (aiResponse && aiResponse.body instanceof ReadableStream) {
				stream = aiResponse.body;
			} else if (aiResponse && typeof aiResponse.getReader === 'function') {
				stream = aiResponse;
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
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return (webhookCallback(bot, 'cloudflare-mod', {
		        onTimeout: 'return',
		}) as any)(request, env, executionCtx);
		},
		};
