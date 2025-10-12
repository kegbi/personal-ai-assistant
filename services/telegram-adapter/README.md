# Telegram Adapter

Lightweight bridge between the Telegram Bot API and the NestJS agent server. It normalises incoming updates into the shared `MessageReceivedDto` contract, forwards them to `/events` on the agent, and delivers the `AgentResponseDto` back to Telegram.

## Configuration

Set the following environment variables (either via `infra/.telegram.env` or your shell):

| Variable | Required | Description |
| --- | --- | --- |
| `TG_BOT_TOKEN` | ✅ | Bot token from @BotFather. |
| `AGENT_BASE_URL` | ✅ | Base URL of the agent server (e.g. `http://agent-server:3000`). |
| `AGENT_AUTH_TOKEN` | ⭕ | Optional bearer token if the agent requires auth. `AGENT_API_KEY` is also recognised. |
| `ALLOWED_CHAT_IDS` | ⭕ | Comma-separated list of allowed private chat/user IDs. |
| `TG_POLLING_TIMEOUT_MS` | ⭕ (default `30000`) | Long-polling timeout. |
| `AGENT_TIMEOUT_MS` | ⭕ (default `45000`) | HTTP timeout for agent calls. |
| `HEALTH_PORT` | ⭕ (default `8081`) | Port for the local health endpoint. |
| `TG_DROP_PENDING_UPDATES` | ⭕ (default `true`) | Drop backlog when the service restarts. |
| `TG_MODE` | implicit | Only `polling` is supported right now; left for future webhook mode. |

If no allow-list variables are set, every private chat is accepted (useful during local testing).

## Local Development

```bash
pnpm install
pnpm run build         # one-off type check / compile
pnpm run start:dev     # hot-reload via tsx
```

The dev server uses long polling and logs each update. The health probe lives at `http://localhost:${HEALTH_PORT}/health`.

## Docker Compose

`infra/docker-compose.yml` already defines an optional `tg-adapter` service. To enable it:

1. Copy `infra/.telegram.env.example` into `infra/.telegram.env` and add your Telegram variables.
2. Uncomment the `tg-adapter` section in `docker-compose.yml`.
3. Run `docker compose up -d --build`.

The container image uses the same PNPM workflow and exposes `/health` on port `8081` for stack checks.

## Behaviour Notes

- Commands `/start`, `/help`, and `/clear` are forwarded with `isCommand=true` so the agent can handle them explicitly.
- Text messages, voice notes (with a signed file URL), and any unknown payloads are normalised into the agent DTO and tagged with lightweight metadata (`messageId`, `chatType`, etc.).
- When an agent response includes `meta.tool`, the adapter logs the tool name and elapsed time but only the text is sent to Telegram.
- Errors calling the agent are surfaced to the user with a friendly retry message, while health status flips to `degraded`.
- The bot automatically leaves non-private chats to avoid being added to groups or channels.

## Health & Metrics

`GET /health` returns:

```jsonc
{
  "status": "ok",
  "uptimeSeconds": 123,
  "ok": true,
  "startedAt": "2025-10-12T10:15:00.000Z",
  "lastUpdateAt": "2025-10-12T10:16:04.000Z",
  "lastAgentInteractionAt": "2025-10-12T10:16:04.500Z",
  "processedUpdates": 4
}
```

If the adapter cannot reach the agent, `status` becomes `degraded` and `lastAgentError` is included in the payload.
