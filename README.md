# Telegram Bot

This is a Telegram Bot built with [grammY](https://grammy.dev/) designed to run on Cloudflare Workers.

## Features

- Built with grammY framework.
- Runs on Cloudflare Workers for high scalability and low latency.
- Supports AI integrations (Gemini, Llama, etc.) via Cloudflare AI.
- Web search capabilities via Tavily.
- Document processing and search.

## Setup

1. **Install dependencies**:
   ```sh
   npm install
   ```

2. **Configure the bot**:
   Update `wrangler.toml` with your desired worker name and bindings.

3. **Set your Telegram Token**:
   Get a token from [@BotFather](https://t.me/BotFather) and add it to your worker:
   ```sh
   npx wrangler secret put SECRET_TELEGRAM_API_TOKEN
   ```

## Deployment

To deploy the bot to Cloudflare Workers:

```sh
npm run deploy
```

## License

Apache-2.0
