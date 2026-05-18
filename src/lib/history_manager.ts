/** Class representing a manager for conversation history stored in KV */
export class HistoryManager {
	constructor(private kv: KVNamespace) {}

	private getKey(userId: number | string, threadId?: number): string {
		return threadId ? `history:${String(userId)}:${String(threadId)}` : `history:${String(userId)}`;
	}

	/**
	 * Get the conversation history for a user
	 * @param userId - the telegram user ID
	 * @param threadId - optional thread ID
	 * @returns array of messages
	 */
	async getHistory(userId: number | string, threadId?: number): Promise<{ role: string; content: string }[]> {
		if (!this.kv) {
			return [];
		}
		const history = await this.kv.get<{ role: string; content: string }[]>(this.getKey(userId, threadId), 'json');
		return history ?? [];
	}

	/**
	 * Add a message and its response to the history
	 * @param userId - the telegram user ID
	 * @param prompt - the user message
	 * @param response - the bot response
	 * @param threadId - optional thread ID
	 */
	async addMessage(userId: number | string, prompt: string, response: string, threadId?: number) {
		if (!this.kv) {
			return;
		}
		const history = await this.getHistory(userId, threadId);
		history.push({ role: 'user', content: prompt });
		history.push({ role: 'assistant', content: response });
		const trimmedHistory = history.slice(-20);
		await this.kv.put(this.getKey(userId, threadId), JSON.stringify(trimmedHistory), {
			expirationTtl: 86400,
		});
	}

	/**
	 * Clear the conversation history for a user
	 * @param userId - the telegram user ID
	 * @param threadId - optional thread ID
	 */
	async clearHistory(userId: number | string, threadId?: number) {
		if (!this.kv) {
			return;
		}
		await this.kv.delete(this.getKey(userId, threadId));
	}
}

/**
 * Get the balance for a user, initializing it if it doesn't exist
 * @param userId - the telegram user ID | string
 * @param kv - the KV namespace
 * @returns the user's balance
 */
export async function getBalance(userId: number | string, kv: KVNamespace): Promise<number> {
	const balanceKey = `balance:${String(userId)}`;
	const balance = await kv.get<number>(balanceKey, 'json');
	if (balance === null) {
		const defaultBalance = 200;
		await kv.put(balanceKey, JSON.stringify(defaultBalance));
		return defaultBalance;
	}
	return balance;
}
