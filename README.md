# Talk to Your Data — SAC Custom Widget

A context-aware chat widget for SAP Analytics Cloud (SAC). It connects directly to a data model via the Builder Panel — no scripting or linked analysis required.

## What it does

- Reads the model assigned to it through SAC's data binding (dimensions + measures feeds)
- Automatically reacts to story/page/input-control filter changes
- Extracts the current filtered context (dimensions, members, measures, row count)
- Displays the context in a chat-style UI inside the SAC story
- Provides a foundation for connecting to a backend AI assistant (API client included)

## How to build

The project uses **Docker** for builds (no local Node.js required).

```bash
# Compile TypeScript + bundle with Vite → dist/main.js
docker compose run --rm builder npm run build

# Build + package into SAC upload zip (dist/talk-to-data-widget.zip)
docker compose run --rm builder npm run build:upload
```

## How to deploy

1. In SAC, go to **Main Menu → Custom Widgets → +**
2. Upload `dist/talk-to-data-widget.zip`
3. Drag the widget onto a story page
4. In the Builder Panel **Data Binding** section, assign a model and drag dimensions/measures into the feeds
5. The widget displays the filtered data context automatically

## Connecting the widget to the backend

The widget communicates with a Python/FastAPI backend via REST. The API client (`src/api-client.ts`) handles all communication.

### Architecture

```
┌─────────────────┐         ┌─────────────────────────┐
│  SAC Story      │         │  Backend (FastAPI)       │
│                 │         │                         │
│  ┌───────────┐  │  HTTP   │  POST /api/ask          │
│  │  Widget   │──┼────────▶│    → queries data       │
│  │           │◀─┼─────────│    → calls LLM          │
│  └───────────┘  │  JSON   │    → returns answer     │
│                 │         │                         │
│                 │         │  GET  /api/health        │
└─────────────────┘         └─────────────────────────┘
```

### Configuration

The widget needs an `ApiConfig` object to connect:

```typescript
const config: ApiConfig = {
  baseUrl: 'https://your-backend.com',  // Backend URL
  apiKey: 'optional-bearer-token',      // Optional auth
  timeoutMs: 30000,                     // Request timeout (default 30s)
}
```

### Request flow

1. User types a question in the widget chat UI
2. Widget collects the current SAC context (measures, dimensions, active filters, row count)
3. Widget sends a `POST /api/ask` request with:
   - `question` — the user's natural language question
   - `context` — the current data binding state (measures, dimensions, filters, row count)
   - `conversationId` — optional, for multi-turn conversations
4. Backend queries the data model, passes context + question to the LLM
5. Backend returns an `AskResponse` with:
   - `answer` — LLM-generated explanation
   - `data` — optional table data (rows + columns) for display
   - `confidence` — high / medium / low
   - `sources` — optional list of sources used
   - `conversationId` — for continuing the conversation

### Health check

Call `GET /api/health` to verify the backend is reachable before sending questions. Returns `{ status: 'ok', version: '...' }` on success.

### Backend requirements

The backend must implement two endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/ask` | POST | Accepts a question + SAC context, returns an LLM answer |
| `/api/health` | GET | Returns service status |

Authentication is optional — if `apiKey` is set in the config, the widget sends it as a `Bearer` token in the `Authorization` header.

## Project structure

```
src/main.ts          → Widget Web Component (entry point)
src/api-client.ts    → Backend API client (standalone module)
sac/widget.json      → SAC manifest
scripts/             → Build helpers (ZIP packaging)
debug/               → Local development HTML harness
```

## Tech stack

TypeScript · Vite (IIFE bundle) · Docker · SAC Custom Widget SDK
