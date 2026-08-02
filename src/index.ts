import { Bot, Api, Context, webhookCallback, GrammyError, HttpError, InputFile } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { Hono } from 'hono';

import { CommandGroup, type CommandsFlavor } from '@grammyjs/commands';
import {
	HistoryManager,
	sanitizeMarkdownV2,
	SYSTEM_PROMPTS,
	AVAILABLE_MODELS,
	DEFAULT_MODEL,
	MAX_HISTORY_MESSAGES,
	PHOTO_COST_STARS,
	VOICE_SURCHARGE_STARS,
	modelConfigById,
	VISION_FALLBACK_MODEL,
	verifyTelegramAuth,
	type Task,
	type Environment,
	type ChatMessage,
	type Tool
} from '@codebam/shared';
import { fetchTool, wikipediaTool, createTavilySearchTool, createSandboxTool, createCodeWorkspaceTool } from './lib/utils.js';
import { createTelegramFileReaderTool, createTelegramFileSearchTool } from './lib/documentTool.js';
import { streamAiResponseToTelegram, customRunWithTools } from './lib/ai.js';
import { accountBalance, accountCharge, accountCredit } from './lib/account.js';

import { getSandbox } from '@cloudflare/sandbox';
export { Sandbox } from '@cloudflare/sandbox';
export { UserAccount } from './lib/account.js';

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	return Buffer.from(buffer).toString('base64');
}

/** Compare two secrets without leaking their contents through timing. */
function secretsMatch(a: string | undefined | null, b: string | undefined | null): boolean {
	if (!a || !b || a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

type MyContext = CommandsFlavor &
	Context & {
		env: Environment;
		executionCtx: ExecutionContext;
	};

export function createBotInstance(token: string): Bot<MyContext> {
	const bot = new Bot<MyContext>(token);
	bot.api.config.use(
		autoRetry({
			maxRetryAttempts: 3,
			maxDelaySeconds: 60,
		}),
	);
	return bot;
}

const HELP_TEXT =
	'Welcome! Here are my commands:\n' +
	'/balance - Check your current Star balance\n' +
	'/load <amount> - Top up your balance with Telegram Stars\n' +
	`/photo <prompt> - Generate an image (${String(PHOTO_COST_STARS)} Stars)\n` +
	'/model <name> - Switch AI model and see costs\n' +
	'/prompt ["prompt"] - Set your custom system prompt (no args to view, "" or reset to clear)\n' +
	'/facts ["facts"] - Set facts about yourself for business mode (no args to view, "" or reset to clear)\n' +
	'<prompt> - Generate text (may use tools if supported by model)\n' +
	`Send a voice note - Transform your bot into a voice assistant (+${String(VOICE_SURCHARGE_STARS)} Stars)\n` +
	'/clear - Clear your conversation history\n' +
	'/commit - Get the latest deployed commit link\n\n' +
	'New users start with 200 free credits!';

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
		console.log(`[getBusinessOwnerData] Cache HIT for connection ${connectionId}`);
	} else {
		console.log(`[getBusinessOwnerData] Cache MISS for connection ${connectionId}. Fetching from Telegram API...`);
		try {
			const result = await api.getBusinessConnection(connectionId);
			const id = result.user?.id || result.user_chat_id;
			const name = result.user?.first_name || 'the business owner';
			const username = result.user?.username;
			if (id) {
				ownerData = { id, name, username };
				console.log(`[getBusinessOwnerData] Resolved owner id=${id}. Caching in KV...`);
				await env.CONVERSATION_HISTORY.put(`active_connection:${id}`, connectionId);
				await env.CONVERSATION_HISTORY.put(`business_connection:${connectionId}`, JSON.stringify(ownerData));
			} else {
				console.error(`[getBusinessOwnerData] Failed to resolve owner ID from result:`, JSON.stringify(result));
			}
		} catch (e) {
			console.error('[getBusinessOwnerData] Failed to fetch business connection:', e);
		}
	}
	return ownerData;
}

/**
 * Fold the document / reply-to context that the user implicitly provided into
 * the prompt text.
 */
function buildPrompt(ctx: MyContext): string {
	let prompt = ctx.msg?.text || ctx.msg?.caption || '';

	const doc = ctx.msg?.document;
	if (doc) {
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

	return prompt;
}

/**
 * Resolve who pays for this update.
 *
 * For business messages the *customer* owns the conversation history but the
 * connected business owner is billed. Returns `null` for the billing id when we
 * cannot determine it, so callers can bail instead of writing to a shared
 * `balance:undefined` key.
 */
async function resolveIdentity(
	ctx: MyContext
): Promise<{ historyUserId: number | string; billingUserId: number | null }> {
	const senderId = ctx.from?.id ?? ctx.update.guest_message?.from?.id ?? null;
	let historyUserId: number | string = senderId ?? 0;
	let billingUserId: number | null = senderId;

	if (ctx.has('business_message')) {
		const bizMsg = ctx.businessMessage;
		const connectionId = bizMsg.business_connection_id;
		const customerId = bizMsg.chat.id;
		if (connectionId && customerId) {
			historyUserId = `business:${connectionId}:${customerId}`;
			const ownerData = await getBusinessOwnerData(ctx.api, ctx.env, connectionId);
			billingUserId = ownerData?.id ?? null;
		}
	}

	return { historyUserId, billingUserId };
}

async function resolveSystemPrompt(ctx: MyContext, billingUserId: number): Promise<string> {
	if (ctx.has('business_message')) {
		let prompt = SYSTEM_PROMPTS.BUSINESS_MODE;
		const connectionId = ctx.businessMessage.business_connection_id;
		if (connectionId) {
			const ownerData = await getBusinessOwnerData(ctx.api, ctx.env, connectionId);
			if (ownerData) {
				const customPrompt = await ctx.env.CONVERSATION_HISTORY.get(`prompt:${String(ownerData.id)}`);
				if (customPrompt) prompt = customPrompt;
				prompt = prompt.replace(/{owner_name}/g, ownerData.name);
				const facts = await ctx.env.CONVERSATION_HISTORY.get(`business_facts:${String(ownerData.id)}`);
				if (facts) prompt += `\n\nHere are some facts about you:\n${facts}`;
			}
		}
		return prompt;
	}

	const customPrompt = await ctx.env.CONVERSATION_HISTORY.get(`prompt:${String(billingUserId)}`);
	const base = customPrompt || SYSTEM_PROMPTS.TUX_ROBOT;
	const isFileTask = !!ctx.msg?.document || !!ctx.msg?.reply_to_message?.document;
	if (isFileTask) {
		return `${base}\n\nEnsure your responses are formatted using supported Telegram MarkdownV2.`;
	}
	return base;
}

/**
 * Price, bill and enqueue a task.
 *
 * Billing goes through the `UserAccount` durable object so that two messages
 * arriving at once cannot both spend the same Stars.
 */
async function chargeStars(ctx: MyContext, task: Task, amountOverride?: number) {
	const historyManager = new HistoryManager(ctx.env.CONVERSATION_HISTORY);
	const { historyUserId, billingUserId } = await resolveIdentity(ctx);

	if (!billingUserId || billingUserId === ctx.me.id) {
		console.log(`[chargeStars] Skipping: billingUserId=${String(billingUserId)}, botId=${ctx.me.id}`);
		return;
	}

	task.userId = historyUserId;
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
		if (await ctx.env.CONVERSATION_HISTORY.get(processedKey)) {
			console.log(`[chargeStars] Update ${ctx.update.update_id} already processed. Skipping duplicate workflow.`);
			return;
		}
	}

	const defaultModel =
		(await ctx.env.FLAGS?.getStringValue('default-model', DEFAULT_MODEL, { userId: String(billingUserId) })) ??
		DEFAULT_MODEL;
	const modelPreference =
		(await ctx.env.CONVERSATION_HISTORY.get<string>(`model:${String(billingUserId)}`)) ?? defaultModel;
	const preferred = AVAILABLE_MODELS[modelPreference] ?? AVAILABLE_MODELS[DEFAULT_MODEL];

	// Fall back to a capable model when the preference cannot handle the task,
	// and price the request against whatever model actually runs.
	let effective = preferred;
	if (task.type === 'tool_call' && !preferred.supportsTools) {
		effective = AVAILABLE_MODELS[defaultModel] ?? AVAILABLE_MODELS[DEFAULT_MODEL];
	} else if ((task.type === 'photo' || task.geminiParts?.some((p) => p.inlineData)) && !preferred.supportsVision) {
		effective = AVAILABLE_MODELS[VISION_FALLBACK_MODEL];
	}
	task.modelId = effective.id;

	const amount = amountOverride ?? effective.cost + (task.type === 'voice' ? VOICE_SURCHARGE_STARS : 0);

	const charge = await accountCharge(ctx.env, billingUserId, amount, {
		model: task.modelId,
		taskType: task.type,
		description: 'AI Bot message charge',
	});

	if (!charge.ok) {
		if (ctx.has('business_message') || ctx.has('guest_message')) {
			await ctx.reply('Insufficient balance. Please go to direct messages and use /load to top up your Stars.', {
				business_connection_id: ctx.businessMessage?.business_connection_id,
				reply_parameters: { message_id: ctx.msgId },
			});
		} else {
			const taskId = crypto.randomUUID();
			// Freeze everything the workflow will need: the entry expires in an
			// hour and there is no second chance to resolve it after payment.
			task.systemPrompt = task.systemPrompt ?? (await resolveSystemPrompt(ctx, billingUserId));
			task.history = task.history ?? (await historyManager.getHistory(historyUserId, task.threadId));
			await ctx.env.CONVERSATION_HISTORY.put(`task:${taskId}`, JSON.stringify(task), { expirationTtl: 3600 });
			await ctx.replyWithInvoice('AI Generation', 'Charge for AI message generation', taskId, 'XTR', [
				{ label: 'Stars', amount },
			]);
		}
		return;
	}

	task.chargedAmount = amount;
	task.billingUserId = billingUserId;

	try {
		await ctx.replyWithChatAction('typing', {
			business_connection_id: ctx.businessMessage?.business_connection_id,
		});
	} catch (e) {
		console.log('[chargeStars] Failed to send chat action (likely not a member):', e);
	}

	task.telegramToken = ctx.env.SECRET_TELEGRAM_API_TOKEN;
	if (!task.systemPrompt) {
		task.systemPrompt = await resolveSystemPrompt(ctx, billingUserId);
	}
	if (!task.history) {
		task.history = await historyManager.getHistory(historyUserId, task.threadId);
	}

	try {
		await ctx.env.STREAM_WORKFLOW.create({ params: task });
	} catch (e) {
		console.error('[chargeStars] Failed to enqueue workflow, refunding:', e);
		await accountCredit(ctx.env, billingUserId, amount, 'refund', {
			model: task.modelId,
			taskType: task.type,
			description: 'Refund: could not start generation',
		});
		throw e;
	}
}

function setupBot(bot: Bot<MyContext>, env: Environment, executionCtx: ExecutionContext) {
	bot.use(async (ctx, next) => {
		const updateType = Object.keys(ctx.update).find((k) => k !== 'update_id');
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

	// NOTE: autoRetry is installed once, in createBotInstance. Installing it a
	// second time here stacked two retry transformers (up to 9 attempts).
	bot.api.config.use(async (prev, method, payload, signal) => {
		console.log(`[Grammy-API] Request: ${method}`);
		const res = await prev(method, payload, signal);
		console.log(`[Grammy-API] Success: ${method}`);
		return res;
	});

	const commands = new CommandGroup<MyContext>();

	commands.command('start', 'Welcome message and command list', async (ctx) => {
		const isDev = ctx.env.ENVIRONMENT === 'dev';
		await ctx.reply(HELP_TEXT + (isDev ? '' : '\n\nClick the button below to open the Web App!'), {
			reply_markup: isDev
				? undefined
				: { inline_keyboard: [[{ text: 'Open Web App', web_app: { url: 'https://tux-robot.codebam.ca' } }]] },
		});
	});

	commands.command('balance', 'Check your current Star balance', async (ctx) => {
		if (!ctx.from?.id) return;
		const balance = await accountBalance(ctx.env, ctx.from.id);
		await ctx.reply(`Your current balance is ${String(balance)} Stars.`);
	});

	commands.command('load', 'Top up your balance with Telegram Stars', async (ctx) => {
		const amount = parseInt(ctx.match || '0', 10);
		if (!Number.isInteger(amount) || amount <= 0 || amount > 1000) {
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
			await chargeStars(ctx, { type: 'gen_photo', prompt }, PHOTO_COST_STARS);
		} else {
			await ctx.reply('Please provide a prompt for the photo. Example: /photo a futuristic city');
		}
	});

	commands.command('clear', 'Clear your conversation history', async (ctx) => {
		const historyManager = new HistoryManager(ctx.env.CONVERSATION_HISTORY);
		const { historyUserId } = await resolveIdentity(ctx);
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
				await ctx.reply(`Invalid model. Available models:\n${Object.keys(AVAILABLE_MODELS).join('\n')}`);
			}
		} else {
			const currentModel = (await ctx.env.CONVERSATION_HISTORY.get<string>(modelKey)) ?? DEFAULT_MODEL;
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

		const syncAliases = async (value: string | null) => {
			const connectionId = await ctx.env.CONVERSATION_HISTORY.get(`active_connection:${String(userId)}`);
			if (!connectionId) return;
			const ownerData = await ctx.env.CONVERSATION_HISTORY.get<{ id: number; name: string; username?: string }>(
				`business_connection:${connectionId}`,
				'json',
			);
			if (!ownerData) return;
			for (const alias of [ownerData.username, ownerData.name]) {
				if (!alias) continue;
				if (value === null) await ctx.env.CONVERSATION_HISTORY.delete(`business_facts:${alias}`);
				else await ctx.env.CONVERSATION_HISTORY.put(`business_facts:${alias}`, value);
			}
		};

		if (factsValue === 'reset' || factsValue === '""' || factsValue === "''") {
			await ctx.env.CONVERSATION_HISTORY.delete(`business_facts:${String(userId)}`);
			await syncAliases(null);
			await ctx.reply('Business facts cleared.');
		} else {
			if (
				(factsValue.startsWith('"') && factsValue.endsWith('"')) ||
				(factsValue.startsWith("'") && factsValue.endsWith("'"))
			) {
				factsValue = factsValue.substring(1, factsValue.length - 1);
			}
			await ctx.env.CONVERSATION_HISTORY.put(`business_facts:${String(userId)}`, factsValue);
			await syncAliases(factsValue);
			await ctx.reply(`Business facts updated to:\n\n${factsValue}`);
		}
	});

	commands.command('commit', 'Get the latest deployed commit link', async (ctx) => {
		const commitSha = ctx.env.COMMIT_SHA || 'unknown';
		if (commitSha === 'unknown' || commitSha === 'dev') {
			await ctx.reply(`Commit: \`${commitSha}\``);
		} else {
			const link = `https://github.com/codebam/cf-workers-telegram-bot/commit/${commitSha}`;
			await ctx.reply(`Latest deployed commit: [${commitSha.substring(0, 7)}](${link})`, { parse_mode: 'Markdown' });
		}
	});

	bot.use(commands);

	bot.on('pre_checkout_query', async (ctx) => {
		// Validate the payload *before* accepting. Approving blindly meant a user
		// could pay for a task whose 1h KV entry had already expired, consuming
		// their Stars for nothing.
		const payload = ctx.preCheckoutQuery.invoice_payload;
		if (payload.startsWith('load:')) {
			const amount = parseInt(payload.slice(5), 10);
			if (!Number.isInteger(amount) || amount <= 0 || amount > 1000) {
				await ctx.answerPreCheckoutQuery(false, 'That top-up amount is no longer valid.');
				return;
			}
			await ctx.answerPreCheckoutQuery(true);
			return;
		}

		const task = await ctx.env.CONVERSATION_HISTORY.get(`task:${payload}`);
		if (!task) {
			await ctx.answerPreCheckoutQuery(false, 'This request expired. Please send your message again.');
			return;
		}
		await ctx.answerPreCheckoutQuery(true);
	});

	bot.on('message:successful_payment', async (ctx) => {
		const payment = ctx.message.successful_payment;
		const payload = payment.invoice_payload;
		const userId = ctx.from?.id;
		if (!userId) return;

		// Telegram can redeliver the update; the charge id is the natural key.
		const chargeId = payment.telegram_payment_charge_id;
		const paymentKey = `payment:${chargeId}`;
		if (await ctx.env.CONVERSATION_HISTORY.get(paymentKey)) {
			console.log(`[successful_payment] Charge ${chargeId} already credited. Skipping.`);
			return;
		}
		await ctx.env.CONVERSATION_HISTORY.put(paymentKey, 'true', { expirationTtl: 86400 * 30 });

		if (payload.startsWith('load:')) {
			const amount = parseInt(payload.slice(5), 10);
			if (!Number.isInteger(amount) || amount <= 0) {
				console.error(`[successful_payment] Malformed load payload: ${payload}`);
				await ctx.reply('Something went wrong reading that top-up. Please contact support.');
				return;
			}
			const result = await accountCredit(ctx.env, userId, amount, 'load', {
				description: 'Telegram Stars Top-up',
			});
			await ctx.reply(`Successfully loaded ${String(amount)} Stars! New balance: ${String(result.balance)} Stars.`);
			return;
		}

		const task = await ctx.env.CONVERSATION_HISTORY.get<Task>(`task:${payload}`, 'json');
		if (!task) {
			// Pre-checkout validated this, so the entry expired in the gap. Give
			// the Stars back rather than silently keeping them.
			console.error(`[successful_payment] Task ${payload} vanished after pre-checkout. Refunding.`);
			try {
				await ctx.api.refundStarPayment(userId, chargeId);
				await ctx.reply('That request expired before it could run, so your Stars have been refunded.');
			} catch (e) {
				console.error('[successful_payment] Refund failed:', e);
				await ctx.reply('Error: request expired and the automatic refund failed. Please contact support.');
			}
			return;
		}
		task.telegramToken = ctx.env.SECRET_TELEGRAM_API_TOKEN;
		// Paid directly rather than debited, so there is nothing to refund on
		// failure through the balance ledger.
		task.chargedAmount = undefined;
		await ctx.env.STREAM_WORKFLOW.create({ params: task });
		await ctx.env.CONVERSATION_HISTORY.delete(`task:${payload}`);
	});

	bot.on('business_connection', async (ctx) => {
		const connection = ctx.businessConnection;
		await ctx.env.CONVERSATION_HISTORY.put(`active_connection:${connection.user.id}`, connection.id);
		await ctx.env.CONVERSATION_HISTORY.put(
			`business_connection:${connection.id}`,
			JSON.stringify({
				id: connection.user.id,
				name: connection.user.first_name || 'the business owner',
				username: connection.user.username,
			}),
		);
	});

	bot.on('message:voice', async (ctx) => {
		await chargeStars(ctx, { type: 'voice', prompt: '', fileId: ctx.message.voice.file_id });
	});

	bot.on('message:photo', async (ctx) => {
		const photo = ctx.message.photo;
		const largest = photo[photo.length - 1];
		await chargeStars(ctx, {
			type: 'photo',
			prompt: buildPrompt(ctx) || 'Please describe this image',
			fileId: largest.file_id,
		});
	});

	bot.on('message:document', async (ctx) => {
		await chargeStars(ctx, { type: 'tool_call', prompt: buildPrompt(ctx) });
	});

	bot.on('message:text', async (ctx) => {
		await chargeStars(ctx, { type: 'tool_call', prompt: buildPrompt(ctx) });
	});

	bot.on('business_message', async (ctx) => {
		const photo = ctx.businessMessage.photo;
		if (photo) {
			await chargeStars(ctx, {
				type: 'photo',
				prompt: buildPrompt(ctx) || 'Please describe this image',
				fileId: photo[photo.length - 1].file_id,
			});
			return;
		}
		await chargeStars(ctx, { type: 'business_message', prompt: buildPrompt(ctx) });
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
				await ctx.api.answerGuestQuery(guestMessage.guest_query_id, {
					type: 'article',
					id: crypto.randomUUID(),
					title: 'Welcome',
					input_message_content: {
						message_text: HELP_TEXT + (isDev ? '' : '\n\nClick the button below to open the Web App!'),
					},
					reply_markup: isDev
						? undefined
						: { inline_keyboard: [[{ text: 'Open Web App', url: 'https://tux-robot.codebam.ca' }]] },
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

/** Build the tool list for a task, honouring feature flags and model support. */
function buildTools(env: Environment, task: Task, messages: ChatMessage[], modelId: string, api: Api, opts: { sandbox: boolean; tavily: boolean }): Tool[] {
	const tools: Tool[] = [fetchTool as unknown as Tool, wikipediaTool as unknown as Tool];
	if (opts.tavily) {
		tools.push(createTavilySearchTool(env.TAVILY_API_KEY || '') as unknown as Tool);
	}
	if (opts.sandbox) {
		tools.push(createSandboxTool(env, env.Sandbox as any, String(task.userId)) as unknown as Tool);
		tools.push(
			createTelegramFileReaderTool(env, env.Sandbox as any, String(task.userId), messages, modelId) as unknown as Tool,
		);
		tools.push(createCodeWorkspaceTool(env, env.Sandbox as any, String(task.userId), api, task) as unknown as Tool);
	}
	tools.push(createTelegramFileSearchTool(env, String(task.userId), modelId) as unknown as Tool);
	return tools;
}

async function processTask(task: Task, env: Environment): Promise<void> {
	const token = env.SECRET_TELEGRAM_API_TOKEN;
	if (!token) {
		throw new Error('SECRET_TELEGRAM_API_TOKEN is empty in processTask');
	}
	const botInstance = createBotInstance(token);

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
					console.log(`[processTask] Whisper Cache HIT.`);
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
				reply_parameters: task.messageId ? { message_id: task.messageId } : undefined,
			});
			throw e;
		}
	}

	if (task.type === 'gen_photo') {
		const response = (await env.AI.run('@cf/black-forest-labs/flux-1-schnell', {
			prompt: task.prompt,
		})) as { image: string };

		if (!response.image) {
			throw new Error('Image generation returned no image');
		}
		const binaryString = atob(response.image);
		const bytes = new Uint8Array(binaryString.length);
		for (let i = 0; i < binaryString.length; i++) {
			bytes[i] = binaryString.charCodeAt(i);
		}
		await botInstance.api.sendPhoto(task.chatId!, new InputFile(bytes, 'photo.png'), {
			business_connection_id: task.businessConnectionId,
			reply_parameters: task.messageId ? { message_id: task.messageId } : undefined,
		});
		return;
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
					{ inlineData: { mimeType: 'image/jpeg', data: base64Data } },
				];
				try {
					const sandbox = getSandbox(env.Sandbox as any, String(task.userId));
					await sandbox.writeFile('/workspace/uploaded_image.png', base64Data);
				} catch (se) {
					console.warn(`[processTask] Sandbox not bound or failed writing image:`, se);
				}
			}
		} catch (e) {
			console.error('[processTask] Failed to download image for vision task:', e);
		}
	}

	const messages: ChatMessage[] = [
		{ role: 'system', content: task.systemPrompt || 'You are a helpful assistant.' },
		...(task.history || []),
		userMessage,
	];
	const modelId = task.modelId || AVAILABLE_MODELS[DEFAULT_MODEL].id;
	const modelConfig = modelConfigById(modelId);

	// Models without tool support choke on a tools array; only offer tools to
	// models that advertise them.
	const tools = modelConfig?.supportsTools
		? buildTools(env, task, messages, modelId, botInstance.api, { sandbox: true, tavily: true })
		: [];

	const responseContent = await streamAiResponseToTelegram(
		{ env, api: botInstance.api },
		env.AI,
		modelId,
		messages,
		task,
		tools,
	);

	if (task.userId && responseContent) {
		const historyManager = new HistoryManager(env.CONVERSATION_HISTORY);
		await historyManager.addMessage(task.userId, task.prompt, responseContent, task.threadId);
	}
}

export class BotWorkflow extends WorkflowEntrypoint<Environment, Task> {
	async run(event: WorkflowEvent<Task>, step: WorkflowStep) {
		const task = event.payload;

		if (
			task.type !== 'message' &&
			task.type !== 'business_message' &&
			task.type !== 'tool_call' &&
			task.type !== 'photo' &&
			task.type !== 'voice' &&
			task.type !== 'gen_photo'
		) {
			return;
		}

		const processedKey = task.updateId ? `processed_update:${String(task.updateId)}` : null;
		if (processedKey && (await this.env.CONVERSATION_HISTORY.get(processedKey))) {
			console.log(`[BotWorkflow] Update ${task.updateId} already processed. Skipping.`);
			return;
		}

		try {
			await step.do(
				'process task',
				{ retries: { limit: 3, delay: '2 seconds', backoff: 'exponential' }, timeout: '5 minutes' },
				async () => {
					await processTask(task, this.env);
				},
			);
			// Marked only after the work actually succeeded. Writing this up front
			// made every retry a no-op, silently dropping the message.
			if (processedKey) {
				await this.env.CONVERSATION_HISTORY.put(processedKey, 'true', { expirationTtl: 3600 });
			}
		} catch (e) {
			console.error('[BotWorkflow] Task failed after all retries:', e);
			await step.do('refund and notify', { retries: { limit: 2, delay: '2 seconds', backoff: 'exponential' } }, async () => {
				if (task.chargedAmount && task.billingUserId) {
					await accountCredit(this.env, task.billingUserId, task.chargedAmount, 'refund', {
						model: task.modelId,
						taskType: task.type,
						description: 'Refund: generation failed',
					});
				}
				if (task.chatId && task.telegramToken) {
					try {
						await createBotInstance(task.telegramToken).api.sendMessage(
							task.chatId,
							task.chargedAmount
								? 'Sorry, that request failed. Your Stars have been refunded.'
								: 'Sorry, that request failed. Please try again.',
							{
								business_connection_id: task.businessConnectionId,
								reply_parameters: task.messageId ? { message_id: task.messageId } : undefined,
							},
						);
					} catch (notifyErr) {
						console.error('[BotWorkflow] Failed to notify user of failure:', notifyErr);
					}
				}
			});
			throw e;
		}
	}
}

const app = new Hono<{ Bindings: Environment }>();

app.onError((err, c) => {
	console.error(`[Bot Error]: ${err.message}`);
	if (err.stack) console.error(`[Bot Error Stack]:\n${err.stack}`);

	// The Telegram webhook route returns 200 on purpose: a non-2xx makes
	// Telegram redeliver the same broken update in a tight loop. Every other
	// route reports the failure honestly.
	const pathname = new URL(c.req.url).pathname;
	const isWebhookRoute = c.req.method === 'POST' && pathname !== '/verify' && pathname !== '/workflow' && !pathname.startsWith('/api/');
	if (isWebhookRoute) {
		return c.text('Internal handled', 200);
	}
	return c.text('Internal Server Error', 500);
});

// Verify the Telegram webhook secret token on webhook deliveries only.
app.use('*', async (c, next) => {
	if (c.req.method === 'POST') {
		const pathname = new URL(c.req.url).pathname;
		if (pathname !== '/verify' && pathname !== '/workflow' && !pathname.startsWith('/api/')) {
			const expectedSecret = c.env.SECRET_TELEGRAM_WEBHOOK;
			if (expectedSecret) {
				const receivedSecret = c.req.header('X-Telegram-Bot-Api-Secret-Token');
				if (!secretsMatch(receivedSecret, expectedSecret)) {
					console.warn('[Security] Unauthorized webhook request: secret token mismatch');
					return c.text('Unauthorized', 401);
				}
			}
		}
	}
	await next();
});

/**
 * Authenticate a request from the web app. Identity always comes from the
 * signed Telegram proof, never from a caller-supplied user id.
 */
async function authenticate(c: { req: { header: (k: string) => string | undefined }; env: Environment }, proofOverride?: string) {
	const proof = proofOverride ?? c.req.header('x-telegram-auth');
	return verifyTelegramAuth(proof, c.env.SECRET_TELEGRAM_API_TOKEN);
}

app.post('/verify', async (c) => {
	try {
		const body = (await c.req.json()) as { authProof?: string };
		const { valid, userId } = await verifyTelegramAuth(body.authProof, c.env.SECRET_TELEGRAM_API_TOKEN);
		if (valid && userId) {
			return c.json({ valid: true, userId }, 200);
		}
	} catch {
		return c.json({ valid: false }, 401);
	}
	return c.json({ valid: false }, 401);
});

/** Authoritative balance read for the web app. */
app.post('/api/account', async (c) => {
	const { valid, userId } = await authenticate(c);
	if (!valid || !userId) return c.json({ error: 'Unauthorized' }, 401);
	const balance = await accountBalance(c.env, userId);
	return c.json({ userId, balance });
});

/** Atomic debit for the web app (uploads and anything else it prices itself). */
app.post('/api/account/charge', async (c) => {
	const { valid, userId } = await authenticate(c);
	if (!valid || !userId) return c.json({ error: 'Unauthorized' }, 401);

	let body: { amount?: number; description?: string };
	try {
		body = (await c.req.json()) as { amount?: number; description?: string };
	} catch {
		return c.json({ error: 'Invalid JSON' }, 400);
	}

	const amount = Number(body.amount);
	if (!Number.isInteger(amount) || amount < 0 || amount > 100_000) {
		return c.json({ error: 'Invalid amount' }, 400);
	}

	const result = await accountCharge(c.env, userId, amount, {
		taskType: 'webapp',
		description: body.description?.slice(0, 200) || 'Web App charge',
	});
	return c.json(result, result.ok ? 200 : 402);
});

app.post('/workflow', async (c) => {
	const { valid, userId } = await authenticate(c);
	if (!valid || !userId) {
		return c.text('Unauthorized: Invalid or expired Telegram auth proof', 401);
	}

	let task: Task;
	try {
		task = (await c.req.json()) as Task;
	} catch {
		return c.text('Invalid JSON', 400);
	}

	// Identity is taken from the verified proof. Previously the body's userId was
	// used verbatim, which let any authenticated caller run tools inside another
	// user's sandbox and read their uploaded files.
	task.userId = userId;
	task.senderId = userId;
	task.billingUserId = userId;
	task.telegramToken = undefined;
	task.tools = undefined;
	if (Array.isArray(task.history) && task.history.length > MAX_HISTORY_MESSAGES) {
		task.history = task.history.slice(-MAX_HISTORY_MESSAGES);
	}

	// Price from the model registry, never from the request.
	const requested = modelConfigById(task.modelId);
	const preferenceKey = (await c.env.CONVERSATION_HISTORY.get<string>(`model:${String(userId)}`)) ?? DEFAULT_MODEL;
	const modelConfig = requested ?? AVAILABLE_MODELS[preferenceKey] ?? AVAILABLE_MODELS[DEFAULT_MODEL];
	task.modelId = modelConfig.id;

	const charge = await accountCharge(c.env, userId, modelConfig.cost, {
		model: modelConfig.id,
		taskType: task.type,
		description: 'Web App generation',
	});
	if (!charge.ok) {
		return c.json({ error: 'Insufficient balance', balance: charge.balance, shortfall: charge.shortfall }, 402);
	}

	const refund = async (reason: string) => {
		await accountCredit(c.env, userId, modelConfig.cost, 'refund', {
			model: modelConfig.id,
			taskType: task.type,
			description: `Refund: ${reason}`,
		});
	};

	console.log(`[Workflow] user=${userId} type=${task.type} model=${task.modelId} stream=${task.stream}`);

	try {
		const userMessage: ChatMessage = { role: 'user', content: task.prompt };
		if (task.type === 'photo' && task.fileId) {
			try {
				const api = createBotInstance(c.env.SECRET_TELEGRAM_API_TOKEN).api;
				const file = await api.getFile(task.fileId);
				if (file.file_path) {
					const fileUrl = `https://api.telegram.org/file/bot${c.env.SECRET_TELEGRAM_API_TOKEN}/${file.file_path}`;
					const fileRes = await fetch(fileUrl);
					if (fileRes.ok) {
						const base64Data = arrayBufferToBase64(await fileRes.arrayBuffer());
						userMessage.geminiParts = [
							{ text: task.prompt || 'Please describe this image' },
							{ inlineData: { mimeType: 'image/jpeg', data: base64Data } },
						];
						try {
							const sandbox = getSandbox(c.env.Sandbox as any, String(userId));
							await sandbox.writeFile('/workspace/uploaded_image.png', base64Data);
						} catch (se) {
							console.warn(`[Workflow] Sandbox not bound or failed writing image:`, se);
						}
					}
				}
			} catch (e) {
				console.error('[Workflow] Failed to download image for vision task:', e);
			}
		}

		const messages: ChatMessage[] = [
			{ role: 'system', content: task.systemPrompt || 'You are a helpful assistant.' },
			...(task.history || []),
			userMessage,
		];

		const isTavilyEnabled =
			(await c.env.FLAGS?.getBooleanValue('tavily-search', false, { userId: String(userId) })) ?? false;
		const isSandboxEnabled =
			(await c.env.FLAGS?.getBooleanValue('code-sandbox', false, { userId: String(userId) })) ?? false;

		const tools =
			task.type === 'tool_call' && modelConfig.supportsTools
				? buildTools(c.env, task, messages, modelConfig.id, createBotInstance(c.env.SECRET_TELEGRAM_API_TOKEN).api, {
						sandbox: isSandboxEnabled,
						tavily: isTavilyEnabled,
					})
				: [];

		const aiResponse = await customRunWithTools(
			c.env.AI,
			modelConfig.id,
			{ messages, tools },
			{ streamFinalResponse: task.stream || false },
		);

		let stream: ReadableStream | null = null;
		if (aiResponse instanceof ReadableStream) {
			stream = aiResponse;
		} else if (aiResponse && typeof aiResponse === 'object' && 'body' in aiResponse && aiResponse.body instanceof ReadableStream) {
			stream = aiResponse.body;
		} else if (aiResponse && typeof aiResponse === 'object' && 'getReader' in aiResponse && typeof aiResponse.getReader === 'function') {
			stream = aiResponse as unknown as ReadableStream;
		}

		if (task.stream && stream) {
			return new Response(stream, {
				headers: { 'Content-Type': 'text/event-stream', 'x-new-balance': String(charge.balance) },
			});
		}

		return c.json(aiResponse, 200, { 'x-new-balance': String(charge.balance) });
	} catch (e) {
		console.error('[Workflow] Generation failed, refunding:', e);
		await refund('generation failed');
		return c.json({ error: `AI error: ${String(e)}` }, 500);
	}
});

app.all('*', async (c) => {
	const url = new URL(c.req.url);
	const method = c.req.method;

	if (method === 'GET' && c.req.query('command') === 'set') {
		// This endpoint used to be public: anyone could re-register the webhook
		// with drop_pending_updates and flush the queue.
		const adminToken = c.env.SECRET_ADMIN_TOKEN;
		const provided = c.req.query('token') || c.req.header('x-admin-token');
		if (!adminToken) {
			console.warn('[Security] Refusing /?command=set: SECRET_ADMIN_TOKEN is not configured');
			return c.json({ ok: false, error: 'SECRET_ADMIN_TOKEN is not configured' }, 503);
		}
		if (!secretsMatch(provided, adminToken)) {
			console.warn('[Security] Unauthorized webhook registration attempt');
			return c.json({ ok: false, error: 'Unauthorized' }, 401);
		}

		const api = createBotInstance(c.env.SECRET_TELEGRAM_API_TOKEN).api;
		try {
			const result = await api.setWebhook(`${url.origin}${url.pathname}`, {
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
		const bot = createBotInstance(token);
		setupBot(bot, c.env, c.executionCtx);

		try {
			return await webhookCallback(bot, 'hono', {
				timeoutMilliseconds: 15_000,
				onTimeout: 'return',
			})(c);
		} catch (e: any) {
			console.error('[Fetch-Webhook-Error] Error during webhook update handling:', e);
			if (e instanceof GrammyError) {
				console.error(`[Fetch-Webhook-Error] GrammyError: ${e.method}, ${e.error_code}, ${e.description}`);
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
