import { getDocumentProxy, extractText } from 'unpdf';
import JSZip from 'jszip';
import { AVAILABLE_MODELS, type ChatMessage } from '@codebam/shared';

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

function truncateFileContent(text: string): string {
	const LIMIT = 5000;
	if (text.length > LIMIT) {
		console.log(`[parseTelegramFile] Truncating parsed file content from ${text.length} to ${LIMIT} characters.`);
		return text.slice(0, LIMIT) + '\n\n[Document content truncated to first 5000 characters due to token/size limits.]';
	}
	return text;
}

export async function parseTelegramFile(
	telegramToken: string,
	_sandboxBinding: unknown, // keeping for signature compatibility
	_userId: string, // keeping for signature compatibility
	file_id: string,
	file_name: string,
	_supportsVision: boolean,
	_messages?: ChatMessage[]
): Promise<string> {
	try {
		console.log(`[parseTelegramFile] Native JS parsing triggered for FileID: ${file_id}, Name: ${file_name}`);
		
		const getFileUrl = `https://api.telegram.org/bot${telegramToken}/getFile?file_id=${file_id}`;
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

		const downloadUrl = `https://api.telegram.org/file/bot${telegramToken}/${getFileData.result.file_path}`;
		const downloadRes = await fetch(downloadUrl);
		if (!downloadRes.ok) {
			console.error(`[parseTelegramFile] Telegram file download failed: ${downloadRes.status}`);
			return `Error: Failed to download file from Telegram. Status: ${downloadRes.status}`;
		}
		const arrayBuffer = await downloadRes.arrayBuffer();
		console.log(`[parseTelegramFile] File downloaded from Telegram. Size: ${arrayBuffer.byteLength} bytes`);

		const ext = file_name.substring(file_name.lastIndexOf('.')).toLowerCase();

		if (ext === '.pdf') {
			console.log(`[parseTelegramFile] Parsing PDF via unpdf...`);
			const pdf = await getDocumentProxy(new Uint8Array(arrayBuffer));
			const { totalPages, text } = await extractText(pdf, { mergePages: true });
			console.log(`[parseTelegramFile] PDF parsed successfully. Total Pages: ${totalPages}, Text Length: ${text.length}`);
			return truncateFileContent(text) || 'PDF parsed successfully but no text content found.';
		}
		
		if (ext === '.docx' || ext === '.doc') {
			console.log(`[parseTelegramFile] Parsing DOCX/DOC via JSZip...`);
			try {
				const zip = await JSZip.loadAsync(arrayBuffer);
				const documentXml = await zip.file('word/document.xml')?.async('text');
				if (!documentXml) {
					return 'Error: word/document.xml not found in DOCX zip.';
				}
				const matches = documentXml.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
				const text = matches.map(m => m.replace(/<[^>]+>/g, '')).join(' ');
				console.log(`[parseTelegramFile] DOCX/DOC parsed successfully via JSZip. Text Length: ${text.length}`);
				return truncateFileContent(text.trim()) || 'DOCX/DOC parsed successfully but no text content found.';
			} catch (e) {
				console.log(`[parseTelegramFile] JSZip failed for DOCX/DOC. Falling back to legacy binary string extraction...`);
				const text = extractPrintableStrings(arrayBuffer);
				return truncateFileContent(text) || 'DOC/DOCX parsed but no text content found.';
			}
		}

		if (ext === '.pptx' || ext === '.ppt') {
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
				console.log(`[parseTelegramFile] PPTX/PPT parsed successfully via JSZip. Total slides parsed: ${slideTexts.length}`);
				return truncateFileContent(slideTexts.join('\n\n')) || 'PPTX/PPT parsed successfully but no text content found.';
			} catch (e) {
				console.log(`[parseTelegramFile] JSZip failed for PPTX/PPT. Falling back to legacy binary string extraction...`);
				const text = extractPrintableStrings(arrayBuffer);
				return truncateFileContent(text) || 'PPT/PPTX parsed but no text content found.';
			}
		}

		if (ext === '.txt' || ext === '.md' || ext === '.markdown') {
			console.log(`[parseTelegramFile] Parsing TXT/MD file...`);
			const decoder = new TextDecoder('utf-8');
			const text = decoder.decode(arrayBuffer);
			return truncateFileContent(text) || 'TXT/MD file is empty.';
		}

		// Fallback for all other files
		console.log(`[parseTelegramFile] Reading file as plain text fallback...`);
		const decoder = new TextDecoder('utf-8');
		const text = decoder.decode(arrayBuffer);
		return truncateFileContent(text) || 'File is empty.';

	} catch (e) {
		console.error(`[parseTelegramFile] Unexpected error:`, e);
		return `Error executing parseTelegramFile: ${String(e)}`;
	}
}

export const createTelegramFileReaderTool = (
	telegramToken: string,
	sandboxBinding: unknown,
	userId: string,
	messages: ChatMessage[],
	modelId: string
) => {
	const modelConfig = Object.values(AVAILABLE_MODELS).find((cfg) => cfg.id === modelId);
	const supportsVision = modelConfig?.supportsVision || false;

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
			return await parseTelegramFile(telegramToken, sandboxBinding, userId, file_id, file_name, supportsVision, messages);
		},
	};
};
