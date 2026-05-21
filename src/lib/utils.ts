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

import { getSandbox, type Sandbox } from '@cloudflare/sandbox';

export const createSandboxTool = (sandboxBinding: DurableObjectNamespace<Sandbox>, userId: string) => ({
	name: 'code_interpreter',
	description:
		'Execute Python code in a secure sandbox environment. Use this tool for complex calculations, data processing, or running code snippets. The environment has internet access and common libraries (numpy, pandas, matplotlib) installed. Pass multi-line Python source as the `code` argument — do NOT wrap it in shell or `python -c`.',
	parameters: {
		type: 'object',
		properties: {
			code: {
				type: 'string',
				description: 'Python source code to execute, e.g. "print(sum(range(10)))" or a full multi-line program.',
			},
		},
		required: ['code'],
	},
	function: async ({ code }: { code: string }) => {
		try {
			const sandbox = getSandbox(sandboxBinding, userId);
			const result = await sandbox.runCode(code, { language: 'python' });
			return JSON.stringify({
				stdout: result.logs.stdout.join(''),
				stderr: result.logs.stderr.join(''),
				error: result.error ? { name: result.error.name, message: result.error.message } : undefined,
				results: result.results,
			});
		} catch (e) {
			return `Error executing code: ${String(e)}`;
		}
	},
});

import type { Api } from 'grammy';
import { InputFile } from 'grammy';
import type { Environment, Task } from '@codebam/shared';

export const createCodeWorkspaceTool = (
	env: Environment,
	sandboxBinding: DurableObjectNamespace<Sandbox>,
	userId: string,
	api: Api,
	task: Task
) => {
	return {
		name: 'code_workspace',
		description: 'Write, modify, or generate code files in the workspace, run scripts, execute tests/verifications, and optionally return files back to the user.',
		parameters: {
			type: 'object',
			properties: {
				files: {
					type: 'array',
					description: 'List of files to write or modify in the workspace.',
					items: {
						type: 'object',
						properties: {
							path: { type: 'string', description: 'Absolute path of the file (e.g. /workspace/solution.py)' },
							content: { type: 'string', description: 'Content to write to the file' },
						},
						required: ['path', 'content'],
					},
				},
				command: {
					type: 'string',
					description: 'Optional shell command or script to execute in the container (e.g. "pytest", "python solution.py") for verification or generation.'
				},
				output_file: {
					type: 'string',
					description: 'Optional path of a file in the workspace to retrieve and return directly to the user (e.g. /workspace/solution.py).'
				}
			},
			required: ['files']
		},
		function: async ({ files, command, output_file }: { files: Array<{ path: string; content: string }>; command?: string; output_file?: string }) => {
			try {
				const sandbox = getSandbox(sandboxBinding, userId);
				
				// 1. Write the files
				const writeResults = [];
				for (const file of files) {
					console.log(`[CodeWorkspace] Writing file to path: ${file.path}`);
					await sandbox.writeFile(file.path, file.content);
					writeResults.push(`Wrote ${file.path} (${file.content.length} chars)`);
				}

				// 2. Execute verification command if provided
				let executionLog = '';
				if (command) {
					console.log(`[CodeWorkspace] Executing command: ${command}`);
					// We execute it by wrapping it in python subprocess to capture full stdout/stderr
					const wrapperCode = `
import subprocess
import sys

cmd = """${command.replace(/"""/g, '\\"\\"\\"')}"""
print(f"Executing: {cmd}", flush=True)
try:
    res = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=60)
    print("--- STDOUT ---")
    print(res.stdout)
    print("--- STDERR ---")
    print(res.stderr)
    print(f"Exit Code: {res.returncode}")
    sys.exit(res.returncode)
except Exception as e:
    print(f"Error executing command: {e}")
    sys.exit(1)
`.trim();

					const result = await sandbox.runCode(wrapperCode, { language: 'python' });
					const stdout = result.logs.stdout.join('');
					const stderr = result.logs.stderr.join('');
					executionLog = `\nStdout: ${stdout}\nStderr: ${stderr}`;
					if (result.error) {
						executionLog += `\nError: ${result.error.name} - ${result.error.message}`;
					}

					// Update active sandbox logs inside Cloudflare KV for Svelte webapp Dashboard
					const logsPayload = {
						stdout,
						stderr,
						error: result.error ? { name: result.error.name, message: result.error.message } : undefined,
						timestamp: new Date().toISOString(),
						command,
					};
					await env.CONVERSATION_HISTORY.put(`sandbox_logs:${userId}`, JSON.stringify(logsPayload));
				}

				// 3. Retrieve output file and send to user via Telegram
				let fileSentMsg = '';
				if (output_file) {
					console.log(`[CodeWorkspace] Reading output file: ${output_file}`);
					const readRes = await sandbox.readFile(output_file, { encoding: 'base64' });
					const contentBase64 = readRes.content;
					const fileName = output_file.split('/').pop() || 'file';

					if (contentBase64) {
						const binaryString = atob(contentBase64 as string);
						const bytes = new Uint8Array(binaryString.length);
						for (let i = 0; i < binaryString.length; i++) {
							bytes[i] = binaryString.charCodeAt(i);
						}

						console.log(`[CodeWorkspace] Sending document ${fileName} back to user...`);
						await api.sendDocument(Number(task.chatId), new InputFile(bytes, fileName), {
							message_thread_id: task.threadId,
							business_connection_id: task.businessConnectionId,
							caption: `Here is the requested file: \`${fileName}\``,
							parse_mode: 'MarkdownV2',
							reply_parameters: task.messageId ? { message_id: task.messageId } : undefined,
						});
						fileSentMsg = `\nRetrieved and sent ${output_file} back to user via Telegram.`;
					}
				}

				return JSON.stringify({
					success: true,
					files: writeResults,
					execution: executionLog,
					fileSent: fileSentMsg
				});

			} catch (e: any) {
				console.error(`[CodeWorkspace] Error in tool execution:`, e);
				return `Error executing workspace task: ${String(e)}`;
			}
		}
	};
};

