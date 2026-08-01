import { DurableObject } from 'cloudflare:workers';
import {
	DEFAULT_NEW_USER_BALANCE,
	type AccountResult,
	type Environment,
	type Transaction
} from '@codebam/shared';

const MAX_TRANSACTIONS = 50;

/**
 * Authoritative per-user balance ledger.
 *
 * Every credit and debit is serialized through a single durable object
 * instance keyed by the billing user ID, which makes read-modify-write safe.
 * The previous implementation did `get` then `put` against KV, so two
 * concurrent messages both read the same starting balance and the second write
 * clobbered the first — free credits under any concurrency at all.
 *
 * After each mutation the new balance and transaction log are mirrored into KV
 * so that read-only display paths (the dashboard, the SSE feed, `/balance`)
 * stay cheap and unchanged.
 */
export class UserAccount extends DurableObject<Environment> {
	/** Serializes handlers against each other across their `await` points. */
	private queue: Promise<unknown> = Promise.resolve();

	private serialize<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.queue.then(fn, fn);
		// Keep the chain alive even if a caller rejects.
		this.queue = result.then(
			() => undefined,
			() => undefined
		);
		return result;
	}

	/**
	 * Read the balance, seeding it from the legacy KV value the first time this
	 * account is touched so existing users keep their credits.
	 */
	private async load(userId: string): Promise<number> {
		const stored = await this.ctx.storage.get<number>('balance');
		if (typeof stored === 'number') return stored;

		const legacy = await this.env.CONVERSATION_HISTORY.get<number>(`balance:${userId}`, 'json');
		const seeded = typeof legacy === 'number' ? legacy : DEFAULT_NEW_USER_BALANCE;
		await this.ctx.storage.put('balance', seeded);
		return seeded;
	}

	private async mirror(userId: string, balance: number): Promise<void> {
		await this.env.CONVERSATION_HISTORY.put(`balance:${userId}`, JSON.stringify(balance));
	}

	private async record(userId: string, tx: Omit<Transaction, 'timestamp'>): Promise<void> {
		const existing = (await this.ctx.storage.get<Transaction[]>('transactions')) ?? [];
		existing.push({ ...tx, timestamp: new Date().toISOString() });
		const trimmed = existing.slice(-MAX_TRANSACTIONS);
		await this.ctx.storage.put('transactions', trimmed);
		await this.env.CONVERSATION_HISTORY.put(`transactions:${userId}`, JSON.stringify(trimmed));
	}

	async getBalance(userId: string): Promise<number> {
		return this.serialize(async () => {
			const balance = await this.load(userId);
			await this.mirror(userId, balance);
			return balance;
		});
	}

	/**
	 * Atomically debit the account. Returns `ok: false` and leaves the balance
	 * untouched when the user cannot afford the charge.
	 */
	async charge(
		userId: string,
		amount: number,
		meta: Omit<Transaction, 'timestamp' | 'amount' | 'type' | 'newBalance'> = {}
	): Promise<AccountResult> {
		if (!Number.isFinite(amount) || amount < 0) {
			throw new Error(`Invalid charge amount: ${String(amount)}`);
		}
		return this.serialize(async () => {
			const balance = await this.load(userId);
			if (balance < amount) {
				return { ok: false, balance, shortfall: amount - balance };
			}
			const newBalance = balance - amount;
			await this.ctx.storage.put('balance', newBalance);
			await this.mirror(userId, newBalance);
			await this.record(userId, { ...meta, amount, type: 'charge', newBalance });
			return { ok: true, balance: newBalance };
		});
	}

	/** Atomically credit the account (top-ups and refunds). */
	async credit(
		userId: string,
		amount: number,
		type: 'load' | 'refund' = 'load',
		meta: Omit<Transaction, 'timestamp' | 'amount' | 'type' | 'newBalance'> = {}
	): Promise<AccountResult> {
		if (!Number.isFinite(amount) || amount <= 0) {
			throw new Error(`Invalid credit amount: ${String(amount)}`);
		}
		return this.serialize(async () => {
			const balance = await this.load(userId);
			const newBalance = balance + amount;
			await this.ctx.storage.put('balance', newBalance);
			await this.mirror(userId, newBalance);
			await this.record(userId, { ...meta, amount, type, newBalance });
			return { ok: true, balance: newBalance };
		});
	}

	async getTransactions(): Promise<Transaction[]> {
		return (await this.ctx.storage.get<Transaction[]>('transactions')) ?? [];
	}
}

function stub(env: Environment, userId: number | string) {
	const name = String(userId);
	return env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromName(name)) as unknown as UserAccount;
}

/** Read the authoritative balance for a user. */
export async function accountBalance(env: Environment, userId: number | string): Promise<number> {
	return stub(env, userId).getBalance(String(userId));
}

/**
 * Atomically debit a user. Prefer this over any read-then-write against the
 * `balance:` KV key.
 */
export async function accountCharge(
	env: Environment,
	userId: number | string,
	amount: number,
	meta: Omit<Transaction, 'timestamp' | 'amount' | 'type' | 'newBalance'> = {}
): Promise<AccountResult> {
	return stub(env, userId).charge(String(userId), amount, meta);
}

/** Atomically credit a user (top-up or refund). */
export async function accountCredit(
	env: Environment,
	userId: number | string,
	amount: number,
	type: 'load' | 'refund' = 'load',
	meta: Omit<Transaction, 'timestamp' | 'amount' | 'type' | 'newBalance'> = {}
): Promise<AccountResult> {
	return stub(env, userId).credit(String(userId), amount, type, meta);
}
