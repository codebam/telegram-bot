import { getSandbox, type Sandbox } from '@cloudflare/sandbox';
import { AVAILABLE_MODELS, type ChatMessage } from '@codebam/shared';

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	let binary = '';
	const bytes = new Uint8Array(buffer);
	const len = bytes.byteLength;
	for (let i = 0; i < len; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

export const createTelegramFileReaderTool = (
	telegramToken: string,
	sandboxBinding: DurableObjectNamespace<Sandbox>,
	userId: string,
	messages: ChatMessage[],
	modelId: string
) => {
	const modelConfig = Object.values(AVAILABLE_MODELS).find((cfg) => cfg.id === modelId);
	const supportsVision = modelConfig?.supportsVision || false;

	return {
		name: 'read_telegram_file',
		description: 'Read the contents of a Telegram file (such as PDF, DOCX, PPTX, or text files) given its file_id and file_name. If the file is a PDF and the model supports vision, it will also render PDF pages as images and attach them directly to the conversation history so you can see them.',
		parameters: {
			type: 'object',
			properties: {
				file_id: { type: 'string', description: 'The Telegram file_id of the document' },
				file_name: { type: 'string', description: 'The original file name' },
			},
			required: ['file_id', 'file_name'],
		},
		function: async ({ file_id, file_name }: { file_id: string; file_name: string }) => {
			try {
				console.log(`[read_telegram_file] FileID: ${file_id}, Name: ${file_name}, SupportsVision: ${supportsVision}`);
				
				const getFileUrl = `https://api.telegram.org/bot${telegramToken}/getFile?file_id=${file_id}`;
				const getFileRes = await fetch(getFileUrl);
				if (!getFileRes.ok) {
					return `Error: Failed to fetch file info from Telegram API. Status: ${getFileRes.status}`;
				}
				const getFileData = (await getFileRes.json()) as { ok: boolean; result?: { file_path?: string } };
				if (!getFileData.ok || !getFileData.result?.file_path) {
					return `Error: Failed to retrieve file path from Telegram API response.`;
				}

				const downloadUrl = `https://api.telegram.org/file/bot${telegramToken}/${getFileData.result.file_path}`;
				const downloadRes = await fetch(downloadUrl);
				if (!downloadRes.ok) {
					return `Error: Failed to download file from Telegram. Status: ${downloadRes.status}`;
				}
				const arrayBuffer = await downloadRes.arrayBuffer();
				const base64Content = arrayBufferToBase64(arrayBuffer);

				const sandbox = getSandbox(sandboxBinding, userId);
				const safeFileName = file_name.replace(/[^a-zA-Z0-9.-]/g, '_');
				const sandboxPath = `/workspace/${safeFileName}`;
				await sandbox.writeFile(sandboxPath, base64Content, { encoding: 'base64' });

				const pythonCode = `
import sys
import os
import json
import base64

def process_file(file_path, supports_vision):
    ext = os.path.splitext(file_path)[1].lower()
    result = {"text": "", "images": []}
    
    if ext == '.pdf':
        try:
            import pypdf
        except ImportError:
            import subprocess
            subprocess.run([sys.executable, "-m", "pip", "install", "pypdf"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            import pypdf
        try:
            reader = pypdf.PdfReader(file_path)
            text_list = []
            for i, page in enumerate(reader.pages):
                text_list.append(f"--- Page {i+1} ---\\n" + (page.extract_text() or ""))
            result["text"] = "\\n".join(text_list)
            
            if supports_vision:
                try:
                    import subprocess
                    subprocess.run(["pdftoppm", "-jpeg", "-f", "1", "-l", "5", "-r", "150", file_path, "/tmp/page"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    for i in range(1, 6):
                        img_path = f"/tmp/page-{i}.jpg"
                        if os.path.exists(img_path):
                            with open(img_path, "rb") as img_file:
                                result["images"].append(base64.b64encode(img_file.read()).decode("utf-8"))
                except Exception:
                    try:
                        import fitz
                    except ImportError:
                        import subprocess
                        subprocess.run([sys.executable, "-m", "pip", "install", "pymupdf"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                        import fitz
                    doc = fitz.open(file_path)
                    for page in doc[:5]:
                        pix = page.get_pixmap()
                        img_data = pix.tobytes("jpg")
                        base64_data = base64.b64encode(img_data).decode("utf-8")
                        result["images"].append(base64_data)
        except Exception as e:
            result["text"] = f"Error parsing PDF: {str(e)}"
            
    elif ext == '.docx':
        try:
            import docx
        except ImportError:
            import subprocess
            subprocess.run([sys.executable, "-m", "pip", "install", "python-docx"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            import docx
        try:
            doc = docx.Document(file_path)
            result["text"] = "\\n".join([p.text for p in doc.paragraphs])
        except Exception as e:
            result["text"] = f"Error parsing DOCX: {str(e)}"
            
    elif ext == '.pptx':
        try:
            import pptx
        except ImportError:
            import subprocess
            subprocess.run([sys.executable, "-m", "pip", "install", "python-pptx"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            import pptx
        try:
            prs = pptx.Presentation(file_path)
            text_list = []
            for i, slide in enumerate(prs.slides):
                slide_text = []
                for shape in slide.shapes:
                    if hasattr(shape, "text") and shape.text:
                        slide_text.append(shape.text)
                text_list.append(f"--- Slide {i+1} ---\\n" + "\\n".join(slide_text))
            result["text"] = "\\n".join(text_list)
        except Exception as e:
            result["text"] = f"Error parsing PPTX: {str(e)}"
            
    else:
        try:
            with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                result["text"] = f.read()
        except Exception as e:
            result["text"] = f"Error reading text file: {str(e)}"
            
    return result

res = process_file(${JSON.stringify(sandboxPath)}, ${supportsVision ? 'True' : 'False'})
print(json.dumps(res))
`;

				const execResult = await sandbox.runCode(pythonCode, { language: 'python' });
				const stdout = execResult.logs.stdout.join('');
				const stderr = execResult.logs.stderr.join('');

				if (execResult.error) {
					console.error(`[read_telegram_file] Python error:`, execResult.error);
					return `Error executing document parser: ${execResult.error.message}\nStderr: ${stderr}`;
				}

				try {
					const parsedResult = JSON.parse(stdout.trim()) as { text: string; images: string[] };

					if (parsedResult.images && parsedResult.images.length > 0) {
						const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
						if (lastUserMsg) {
							if (!lastUserMsg.geminiParts) {
								lastUserMsg.geminiParts = [];
								if (lastUserMsg.content) {
									lastUserMsg.geminiParts.push({ text: lastUserMsg.content });
								}
							}
							for (const imgBase64 of parsedResult.images) {
								lastUserMsg.geminiParts.push({
									inlineData: {
										mimeType: 'image/jpeg',
										data: imgBase64,
									},
								});
							}
							console.log(`[read_telegram_file] Attached ${parsedResult.images.length} page images to Gemini parts`);
						}
					}

					return parsedResult.text || 'Document parsed successfully but no text content found.';
				} catch (e) {
					console.error(`[read_telegram_file] JSON Parse Error. Stdout:`, stdout, `Error:`, e);
					return `Error: Failed to parse tool output. Stdout: ${stdout}\nStderr: ${stderr}`;
				}
			} catch (e) {
				console.error(`[read_telegram_file] Unexpected error:`, e);
				return `Error executing read_telegram_file: ${String(e)}`;
			}
		},
	};
};
