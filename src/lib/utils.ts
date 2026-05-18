import { marked } from 'marked';

export const fetchTool = {
	name: 'fetch',
	description:
		'Make an HTTP request to fetch a website or API, returning the HTML or JSON. You MUST use this tool when the user asks to fetch a URL, visit a website, or make a GET request, instead of writing code.',
	parameters: {
		type: 'object',
		properties: {
			url: { type: 'string', description: 'The URL to fetch' },
			method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], default: 'GET' },
			headers: { type: 'object', description: 'HTTP headers to include in the request' },
			body: { type: 'string', description: 'The request body' },
		},
		required: ['url'],
	},
	function: async ({ url, method, headers, body }: { url: string; method?: string; headers?: Record<string, string>; body?: string }) => {
		try {
			const res = await fetch(url, {
				method: method || 'GET',
				headers: {
					'User-Agent': 'Mozilla/5.0 (Cloudflare Worker Telegram Bot)',
					...headers,
				},
				body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
			});
			const text = await res.text();
			return text.slice(0, 10000);
		} catch (e) {
			return `Error executing fetch: ${String(e)}`;
		}
	},
};

export const wikipediaTool = {
	name: 'wikipedia',
	description: 'Perform a search on Wikipedia to look up answers, facts, and find information.',
	parameters: {
		type: 'object',
		properties: {
			query: { type: 'string', description: 'The search query to search for' },
		},
		required: ['query'],
	},
	function: async (args: { query?: string; q?: string }) => {
		const query = args.query || args.q || '';
		const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

		try {
			const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&utf8=&format=json`;
			const res = await fetch(wikiUrl, {
				headers: { 'User-Agent': userAgent },
			});
			if (res.status === 200) {
				const data = (await res.json()) as {
					query?: {
						search?: Array<{
							title: string;
							snippet: string;
						}>;
					};
				};
				if (data && data.query && Array.isArray(data.query.search)) {
					const wikiResults = data.query.search.map((item) => ({
						title: item.title,
						snippet: item.snippet.replace(/<\/?[^>]+(>|$)/g, ''), // strip HTML tags
						url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title)}`,
					}));
					if (wikiResults.length > 0) {
						return JSON.stringify({ results: wikiResults });
					}
				}
			}
		} catch (e) {
			return `Error executing Wikipedia search: ${String(e)}`;
		}

		return 'Error executing Wikipedia search: No results found.';
	},
};

export const createTavilySearchTool = (apiKey: string) => ({
	name: 'tavily_search',
	description: 'Search the web for current information on any topic using Tavily. Returns snippets and source URLs.',
	parameters: {
		type: 'object',
		properties: {
			query: { type: 'string', description: 'The search query to search for' },
		},
		required: ['query'],
	},
	function: async (args: { query?: string; q?: string }) => {
		const query = args.query || args.q || '';
		try {
			const res = await fetch(`https://mcp.tavily.com/mcp/?tavilyApiKey=${apiKey}`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Accept: 'application/json, text/event-stream',
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/call',
					params: {
						name: 'tavily_search',
						arguments: { query },
					},
				}),
			});
			const text = await res.text();
			const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
			if (dataLine) {
				const data = JSON.parse(dataLine.substring(6));
				if (data.result && data.result.content && data.result.content.length > 0) {
					return data.result.content[0].text;
				}
				if (data.error) {
					return `Error executing Tavily search: ${data.error.message}`;
				}
			}
			return `Error executing Tavily search: Unexpected response format.`;
		} catch (e) {
			return `Error executing Tavily search: ${String(e)}`;
		}
	},
});

import { getSandbox } from '@cloudflare/sandbox';

export const createSandboxTool = (sandboxBinding: any, userId: string) => ({
	name: 'code_interpreter',
	description:
		'Execute python or bash code in a secure sandbox environment. Use this tool for complex calculations, data processing, or running code snippets. The environment has internet access and common libraries installed.',
	parameters: {
		type: 'object',
		properties: {
			command: {
				type: 'string',
				description: 'The shell command to execute, e.g. "python -c \'print(1+1)\'" or "ls -R"',
			},
		},
		required: ['command'],
	},
	function: async ({ command }: { command: string }) => {
		try {
			const sandbox = getSandbox(sandboxBinding, userId);
			const result = await sandbox.exec(command);
			return JSON.stringify({
				stdout: result.stdout,
				stderr: result.stderr,
				exitCode: result.exitCode,
				success: result.success,
			});
		} catch (e) {
			return `Error executing code: ${String(e)}`;
		}
	},
});
