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
			const res = await fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					api_key: apiKey,
					query,
					include_images: false,
					include_answer: false,
				}),
			});
			if (!res.ok) {
				return `Error executing Tavily search: HTTP ${res.status}`;
			}
			const data = (await res.json()) as {
				results?: Array<{ title: string; url: string; content: string }>;
			};
			if (data.results && data.results.length > 0) {
				return JSON.stringify(
					data.results.map((r) => ({
						title: r.title,
						url: r.url,
						content: r.content,
					}))
				);
			}
			return 'No search results found.';
		} catch (e) {
			return `Error executing Tavily search: ${String(e)}`;
		}
	},
});

import { getSandbox, type Sandbox } from '@cloudflare/sandbox';

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	return Buffer.from(buffer).toString('base64');
}

export async function syncUserSandboxWorkspace(userId: string, env: Environment): Promise<void> {
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

export const createSandboxTool = (env: Environment, sandboxBinding: DurableObjectNamespace<Sandbox>, userId: string) => ({
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
			await syncUserSandboxWorkspace(userId, env);
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
				await syncUserSandboxWorkspace(userId, env);
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
					const base64Command = Buffer.from(command).toString('base64');
					const wrapperCode = `
import base64
import subprocess
import sys

cmd = base64.b64decode("${base64Command}").decode('utf-8')
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
						const sentKey = `sent_document:${task.updateId || 'none'}:${fileName}`;
						const alreadySent = await env.CONVERSATION_HISTORY.get(sentKey);

						if (alreadySent) {
							console.log(`[CodeWorkspace] Document ${fileName} already sent for update ${task.updateId}. Skipping.`);
							fileSentMsg = `\nSkipped sending ${output_file} as it was already sent.`;
						} else {
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
							await env.CONVERSATION_HISTORY.put(sentKey, 'true', { expirationTtl: 3600 });
							fileSentMsg = `\nRetrieved and sent ${output_file} back to user via Telegram.`;
						}
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

