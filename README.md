# Amphion

Private orchestration layer for a self-hosted, local-inference AI workspace.

---

## What This Is

Amphion is the system that routes user intent to specialized domain agents,
assembles context, dispatches work, and synthesizes responses into a single
unified voice. It runs entirely on local hardware with no cloud dependencies.

The user-facing product name is configured in `.env` (`DISPLAY_NAME`).
This repo is always "amphion" internally.

---

## Architecture

```
[Desktop App]  →  [Broker]  →  [Dispatcher]  →  [Orchestrator]
                                                       ↓
                                            [Domain MCP Agents]
                                    Research | Finance | Legal | Comms | Proposals | Dev
                                                       ↓
                                              [Voice Layer]
                                                       ↓
                                            [Unified Response]
```

Data layers: PostgreSQL + pgvector (long-term, RAG) · SQLite (session memory + user context)
Inference: Ollama (local, STDIO to agents)

---

## Dev Setup

Prerequisites: Node.js 20+, Docker Desktop

```bash
cp .env.example .env
npm install
npm run dev          # starts pgvector + mock-ollama containers
```

The dev stack uses a mock Ollama service that returns canned responses.
No GPU required to develop against the full pipeline.

---

## Project Structure

```
apps/
  broker/            Node.js orchestration server (the core pipeline)
  desktop/           Electron desktop app
agents/
  _base/             Shared MCP server base class
  research/          Research domain agent
  finance/           Finance domain agent
  legal/             Legal domain agent
  comms/             Communications domain agent
  proposals/         Proposals domain agent
  dev/               Self-augmentation agent
infra/
  docker-compose.yml            Production stack
  docker-compose.dev.yml        Dev stack (mock Ollama + pgvector)
  mock-ollama/                  Mock inference server for dev
  db/migrations/                SQL schema migrations
prompts/                        System prompt files (edit without touching code)
scripts/                        Ingest + seeding utilities
data/                           Runtime SQLite DB (gitignored)
```

---

## Research Notes

Full technology research in `../notespace/RESEARCH/`.
Project report and proposal: `../notespace/RESEARCH/PROJECT-REPORT.txt`.
