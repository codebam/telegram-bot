import { getDocumentProxy, extractText } from 'unpdf';
import JSZip from 'jszip';
import { AVAILABLE_MODELS, type ChatMessage, type Environment } from '@codebam/shared';

function chunkText(text: string, chunkSize = 1000, overlap = 200): string[] {
	const chunks: string[] = [];
	let i = 0;
	while (i < text.length) {
		const chunk = text.slice(i, i + chunkSize);
		chunks.push(chunk);
		i += chunkSize - overlap;
	}
	return chunks;
}

async function getShortHash(str: string): Promise<string> {
	const msgUint8 = new TextEncoder().encode(str);
	const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
	return hashHex.slice(0, 32);
}

function extractPrintableStrings(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let result = '';
	let currentString = '';
	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes[i];
		if ((byte >= 32 && byte <= 126) || byte === 10 || byte === 13 || byte === 9) {
			currentString += String.fromCharCode(byte);
		} else {
			if (currentString.length >= 4) {
				result += currentString + ' ';
			}
			currentString = '';
		}
	}
	if (currentString.length >= 4) {
		result += currentString;
	}
	return result.replace(/\s+/g, ' ').trim();
}

function truncateFileContent(text: string, limit: number): string {
	if (text.length > limit) {
		console.log(`[parseTelegramFile] Truncating parsed file content from ${text.length} to ${limit} characters.`);
		return text.slice(0, limit) + `\n\n[Document content truncated to first ${limit} characters due to token/size limits.]`;
	}
	return text;
}

export async function parseTelegramFile(
	env: Environment,
	_sandboxBinding: unknown, // keeping for signature compatibility
	_userId: string, // keeping for signature compatibility
	file_id: string,
	file_name: string,
	_supportsVision: boolean,
	_messages?: ChatMessage[],
	limit = 2000
): Promise<string> {
	try {
		console.log(`[parseTelegramFile] Native JS parsing triggered for FileID: ${file_id}, Name: ${file_name}, Limit: ${limit}`);
		
		const getFileUrl = `https://api.telegram.org/bot${env.SECRET_TELEGRAM_API_TOKEN}/getFile?file_id=${file_id}`;
		const getFileRes = await fetch(getFileUrl);
		if (!getFileRes.ok) {
			console.error(`[parseTelegramFile] Telegram getFile failed: ${getFileRes.status}`);
			return `Error: Failed to fetch file info from Telegram API. Status: ${getFileRes.status}`;
		}
		const getFileData = (await getFileRes.json()) as { ok: boolean; result?: { file_path?: string } };
		if (!getFileData.ok || !getFileData.result?.file_path) {
			console.error(`[parseTelegramFile] Telegram getFile response invalid:`, getFileData);
			return `Error: Failed to retrieve file path from Telegram API response.`;
		}

		const downloadUrl = `https://api.telegram.org/file/bot${env.SECRET_TELEGRAM_API_TOKEN}/${getFileData.result.file_path}`;
		const downloadRes = await fetch(downloadUrl);
		if (!downloadRes.ok) {
			console.error(`[parseTelegramFile] Telegram file download failed: ${downloadRes.status}`);
			return `Error: Failed to download file from Telegram. Status: ${downloadRes.status}`;
		}
		const arrayBuffer = await downloadRes.arrayBuffer();
		console.log(`[parseTelegramFile] File downloaded from Telegram. Size: ${arrayBuffer.byteLength} bytes`);

		const ext = file_name.substring(file_name.lastIndexOf('.')).toLowerCase();
		let rawText = '';

		if (ext === '.pdf') {
			console.log(`[parseTelegramFile] Parsing PDF via unpdf...`);
			const pdf = await getDocumentProxy(new Uint8Array(arrayBuffer));
			const { totalPages, text } = await extractText(pdf, { mergePages: true });
			console.log(`[parseTelegramFile] PDF parsed successfully. Total Pages: ${totalPages}, Text Length: ${text.length}`);
			rawText = text || '';
		} else if (ext === '.docx' || ext === '.doc') {
			console.log(`[parseTelegramFile] Parsing DOCX/DOC via JSZip...`);
			try {
				const zip = await JSZip.loadAsync(arrayBuffer);
				const documentXml = await zip.file('word/document.xml')?.async('text');
				if (documentXml) {
					const matches = documentXml.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
					rawText = matches.map(m => m.replace(/<[^>]+>/g, '')).join(' ').trim();
				}
			} catch (e) {
				console.log(`[parseTelegramFile] JSZip failed for DOCX/DOC. Falling back to legacy binary string extraction...`);
				rawText = extractPrintableStrings(arrayBuffer);
			}
		} else if (ext === '.pptx' || ext === '.ppt') {
			console.log(`[parseTelegramFile] Parsing PPTX/PPT via JSZip...`);
			try {
				const zip = await JSZip.loadAsync(arrayBuffer);
				const slideTexts: string[] = [];
				const files = Object.keys(zip.files).filter(name => name.startsWith('ppt/slides/slide') && name.endsWith('.xml'));
				files.sort((a, b) => {
					const numA = parseInt(a.replace(/[^0-9]/g, ''), 10);
					const numB = parseInt(b.replace(/[^0-9]/g, ''), 10);
					return numA - numB;
				});

				for (const file of files) {
					const slideXml = await zip.file(file)?.async('text');
					if (slideXml) {
						const slideNum = file.replace(/[^0-9]/g, '');
						const matches = slideXml.match(/<a:t[^>]*>([^<]*)<\/a:t>/g) || [];
						const text = matches.map(m => m.replace(/<[^>]+>/g, '')).join(' ');
						if (text.trim()) {
							slideTexts.push(`--- Slide ${slideNum} ---\n${text.trim()}`);
						}
					}
				}
				rawText = slideTexts.join('\n\n');
			} catch (e) {
				console.log(`[parseTelegramFile] JSZip failed for PPTX/PPT. Falling back to legacy binary string extraction...`);
				rawText = extractPrintableStrings(arrayBuffer);
			}
		} else if (ext === '.txt' || ext === '.md' || ext === '.markdown') {
			console.log(`[parseTelegramFile] Parsing TXT/MD file...`);
			const decoder = new TextDecoder('utf-8');
			rawText = decoder.decode(arrayBuffer);
		} else {
			console.log(`[parseTelegramFile] Reading file as plain text fallback...`);
			const decoder = new TextDecoder('utf-8');
			rawText = decoder.decode(arrayBuffer);
		}

		if (!rawText.trim()) {
			return 'Document parsed successfully but no text content found.';
		}

		// Store document introduction/first 3000 chars in KV cache for quick overview retrievals
		const introKey = `doc_intro:${file_id}`;
		await env.CONVERSATION_HISTORY.put(introKey, rawText.substring(0, 3000), { expirationTtl: 86400 * 7 });

		// RAG flow for large files
		if (rawText.length >= 30000 && env.VECTORIZE) {
			const indexedKey = `indexed:${file_id}`;
			const isAlreadyIndexed = await env.CONVERSATION_HISTORY.get(indexedKey);
			if (isAlreadyIndexed) {
				console.log(`[parseTelegramFile] File ${file_id} already indexed. Skipping indexing.`);
				return `[SUCCESS] The document "${file_name}" is large and has been successfully indexed into the vector database. To access its contents, you MUST use the "search_telegram_file" tool with specific search queries. Do NOT assume you know the contents without searching.`;
			}

			const chunks = chunkText(rawText, 1000, 200);
			console.log(`[parseTelegramFile] Chunked document into ${chunks.length} chunks. Generating embeddings in parallel...`);

			// Generate embeddings in parallel to prevent sequential wall-clock request timeouts
			const embedResPromises = chunks.map(async (chunk, idx) => {
				try {
					const res = (await env.AI.run('@cf/baai/bge-large-en-v1.5', {
						text: [chunk]
					})) as { data: number[][] };
					if (res && res.data && res.data[0]) {
						console.log(`[parseTelegramFile] Completed embedding for chunk ${idx + 1}/${chunks.length}`);
						return { index: idx, vector: res.data[0], chunk };
					}
				} catch (e) {
					console.error(`[parseTelegramFile] Failed to generate embedding for chunk ${idx}:`, e);
				}
				return null;
			});

			const embedDataRaw = await Promise.all(embedResPromises);
			const cleanEmbedData = embedDataRaw.filter((d): d is { index: number; vector: number[]; chunk: string } => d !== null);

			if (cleanEmbedData.length > 0) {
				const fileHash = await getShortHash(file_id);

				// Store chunk texts in KV instead of Vectorize metadata to prevent RPC size limit/hang issues
				for (const item of cleanEmbedData) {
					const chunkKey = `doc_chunk:${fileHash}_${item.index}`;
					await env.CONVERSATION_HISTORY.put(chunkKey, item.chunk, { expirationTtl: 86400 * 7 });
				}

				const vectors = cleanEmbedData.map((item) => ({
					id: `${fileHash}_${item.index}`,
					values: item.vector,
					metadata: {
						file_id,
						file_name,
						chunk_index: item.index
					}
				}));

				// Batch upsert in sizes of 20
				const batchSize = 20;
				for (let i = 0; i < vectors.length; i += batchSize) {
					const batch = vectors.slice(i, i + batchSize);
					await env.VECTORIZE.upsert(batch);
				}

				await env.CONVERSATION_HISTORY.put(indexedKey, 'true', { expirationTtl: 86400 * 7 });
				console.log(`[parseTelegramFile] Successfully indexed ${chunks.length} vectors for ${file_id}`);
				return `[SUCCESS] The document "${file_name}" is large and has been successfully indexed into the vector database. To access its contents, you MUST use the "search_telegram_file" tool with specific search queries. Do NOT assume you know the contents without searching.`;
			}
		}

		// Fallback for smaller files or if VECTORIZE is not bound
		return truncateFileContent(rawText, limit);

	} catch (e) {
		console.error(`[parseTelegramFile] Unexpected error:`, e);
		return `Error executing parseTelegramFile: ${String(e)}`;
	}
}

export const createTelegramFileReaderTool = (
	env: Environment,
	sandboxBinding: unknown,
	userId: string,
	messages: ChatMessage[],
	modelId: string
) => {
	const modelConfig = Object.values(AVAILABLE_MODELS).find((cfg) => cfg.id === modelId);
	const supportsVision = modelConfig?.supportsVision || false;
	const limit = 50000;

	return {
		name: 'read_telegram_file',
		description: 'Read the contents of a Telegram file (such as PDF, DOC, DOCX, PPT, PPTX, TXT, or MD/Markdown files) given its file_id and file_name.',
		parameters: {
			type: 'object',
			properties: {
				file_id: { type: 'string', description: 'The Telegram file_id of the document' },
				file_name: { type: 'string', description: 'The original file name' },
			},
			required: ['file_id', 'file_name'],
		},
		function: async ({ file_id, file_name }: { file_id: string; file_name: string }) => {
			return await parseTelegramFile(env, sandboxBinding, userId, file_id, file_name, supportsVision, messages, limit);
		},
	};
};

export const createTelegramFileSearchTool = (
	env: Environment,
	_modelId: string
) => {
	return {
		name: 'search_telegram_file',
		description: 'Search the contents of an indexed large Telegram document using semantic search (Vector RAG). Use this tool to answer specific questions about the document.',
		parameters: {
			type: 'object',
			properties: {
				file_id: { type: 'string', description: 'The Telegram file_id of the document' },
				query: { type: 'string', description: 'The semantic search query to look up inside the document' },
				file_name: { type: 'string', description: 'The original name of the file' },
			},
			required: ['file_id', 'query'],
		},
		function: async ({ file_id, query, file_name }: { file_id: string; query: string; file_name?: string }) => {
			try {
				if (!env.VECTORIZE) {
					return 'Error: Vectorize index is not bound in this environment.';
				}

				// Ensure the file is indexed on-the-fly if not already cached in KV
				const introKey = `doc_intro:${file_id}`;
				let intro = await env.CONVERSATION_HISTORY.get<string>(introKey);
				if (!intro) {
					console.log(`[search_telegram_file] File ${file_id} not indexed in KV yet. Running parseTelegramFile on-the-fly...`);
					const parseResult = await parseTelegramFile(
						env,
						undefined,
						'',
						file_id,
						file_name || 'document.md',
						false,
						undefined,
						30000
					);
					console.log(`[search_telegram_file] On-the-fly indexing result:`, parseResult);
					intro = await env.CONVERSATION_HISTORY.get<string>(introKey);
				}

				// Intercept generic summary / overview queries and immediately return cached document intro
				const isGenericQuery = /summary|overview|about|what is this|description/i.test(query);
				if (isGenericQuery) {
					console.log(`[search_telegram_file] Intercepted generic summary/overview query: "${query}"`);
					if (intro) {
						return `[Document Overview / Introduction]:\n\n${intro}`;
					}
				}

				console.log(`[search_telegram_file] Embedding query: "${query}"`);
				const embedRes = (await env.AI.run('@cf/baai/bge-large-en-v1.5', {
					text: [query]
				})) as { data: number[][] };

				const queryVector = embedRes.data[0];

				console.log(`[search_telegram_file] Querying Vectorize for FileID: ${file_id}`);
				const searchRes = await env.VECTORIZE.query(queryVector, {
					topK: 3,
					filter: { file_id },
					returnMetadata: true
				});

				if (!searchRes.matches || searchRes.matches.length === 0) {
					console.log(`[search_telegram_file] Vectorize returned 0 matches. Attempting intro fallback.`);
					const intro = await env.CONVERSATION_HISTORY.get(`doc_intro:${file_id}`);
					if (intro) {
						return `No specific semantic matches found for "${query}". Here is the document overview / introduction for context:\n\n${intro}`;
					}
					return `No relevant matches found in the document for query: "${query}"`;
				}

				const matchesPromises = searchRes.matches.map(async (match, i) => {
					const chunkKey = `doc_chunk:${match.id}`;
					const text = await env.CONVERSATION_HISTORY.get(chunkKey) || 'No text content';
					return `[Match ${i + 1}] (Relevance: ${(match.score * 100).toFixed(1)}%)\n${text}`;
				});

				const matches = (await Promise.all(matchesPromises)).join('\n\n');

				return `Search results for "${query}":\n\n${matches}`;
			} catch (e) {
				console.error(`[search_telegram_file] Error querying vector index:`, e);
				return `Error executing search_telegram_file: ${String(e)}`;
			}
		}
	};
};
