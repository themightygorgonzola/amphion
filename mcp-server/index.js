#!/usr/bin/env node
/**
 * amphion-mcp — MCP server exposing Amphion broker tools
 *
 * Tools:
 *   amphion_query   — ask Amphion a question (SSE stream → text)
 *   amphion_learn   — kick off a background research task
 *   ppm_status      — list all PPM services and their health
 *   ppm_logs        — recent events for a named PPM service
 *   list_workspaces — list registered workspaces
 *
 * Config (env vars):
 *   AMPHION_BROKER_URL  — broker base URL (default: http://localhost:3000)
 *   AMPHION_BROKER_KEY  — Bearer key for broker auth
 *   PPM_URL             — PPM controller base URL (default: http://localhost:7000)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BROKER_URL       = (process.env.AMPHION_BROKER_URL  ?? 'http://localhost:3000').replace(/\/$/, '');
const BROKER_KEY       = process.env.AMPHION_BROKER_KEY  ?? '';
const PPM_URL          = (process.env.PPM_URL             ?? 'http://localhost:7000').replace(/\/$/, '');
// Default workspace scope for this MCP instance — set per VS Code workspace via .continue/config.yaml
const DEFAULT_WORKSPACE = process.env.AMPHION_WORKSPACE_ID ?? null;

const QUERY_TIMEOUT_MS = 120_000;

function brokerHeaders() {
  return {
    'Content-Type': 'application/json',
    ...(BROKER_KEY ? { Authorization: `Bearer ${BROKER_KEY}` } : {}),
  };
}

/**
 * POST /query → collect SSE stream, return { answer, cards }
 * Events: data: {"type":"token","token":"..."}\n\n
 *         data: {"type":"card","card":{...}}\n\n
 *         data: {"type":"run_done",...}\n\n
 *         data: {"type":"done",...}\n\n
 */
async function collectQuery(message, sessionId, userId, workspaceId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);

  const resolvedWorkspace = workspaceId ?? DEFAULT_WORKSPACE ?? undefined;

  let res;
  try {
    res = await fetch(`${BROKER_URL}/query`, {
      method: 'POST',
      headers: brokerHeaders(),
      body: JSON.stringify({
        message,
        sessionId:   sessionId ?? undefined,
        userId:      userId ?? 'default',
        workspaceId: resolvedWorkspace,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Broker /query returned ${res.status}: ${body}`);
  }

  const tokens = [];
  const cards = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let finished = false;

  try {
    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // SSE events are separated by \n\n; each line may be "data: ..."
      const parts = buf.split('\n\n');
      buf = parts.pop(); // keep potential incomplete tail

      for (const part of parts) {
        for (const line of part.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          let event;
          try { event = JSON.parse(line.slice(6)); } catch { continue; }

          if (event.type === 'token' && typeof event.token === 'string') {
            tokens.push(event.token);
          } else if (event.type === 'card' && event.card) {
            cards.push(event.card);
          } else if (event.type === 'error') {
            throw new Error(`Broker error: ${event.message ?? JSON.stringify(event)}`);
          } else if (event.type === 'run_done' || event.type === 'done') {
            finished = true;
          }
        }
        if (finished) break;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  return { answer: tokens.join(''), cards };
}

/**
 * Resolve a project name or ID to a project ID by querying PPM
 */
async function resolvePpmId(nameOrId) {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 8000);
  const res = await fetch(`${PPM_URL}/api/projects`, { signal: ac.signal });
  if (!res.ok) throw new Error(`PPM /api/projects returned ${res.status}`);
  const projects = await res.json();

  if (nameOrId.startsWith('proj_')) {
    const exact = projects.find(p => p.id === nameOrId);
    if (exact) return exact.id;
  }

  const match = projects.find(
    p => p.name === nameOrId || p.name.toLowerCase().includes(nameOrId.toLowerCase())
  );
  if (!match) throw new Error(`No PPM project found matching "${nameOrId}". Run ppm_status to see available services.`);
  return match.id;
}

// ── MCP Server setup ─────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'amphion',
  version: '1.0.0',
});

// ── Tool: amphion_query ───────────────────────────────────────────────────────

server.tool(
  'amphion_query',
  'Ask Amphion a question or give it a task. Amphion is the local AI assistant running on miracle — it has semantic memory, document knowledge, conversation history, and can call agents. Use this for research, code help, document search, and any context-aware questions. Scoped to the active workspace by default.',
  {
    message: z.string().describe('The question or task to send to Amphion'),
    session_id: z.string().optional().describe(
      'Session ID to continue an existing conversation. Omit to start a fresh session.'
    ),
    user_id: z.string().optional().describe(
      'User identity for conversation tracking. Defaults to "default".'
    ),
    workspace: z.string().optional().describe(
      'Override the active workspace for this query (e.g. "lichess-bot-redux", "amphion"). ' +
      'Defaults to AMPHION_WORKSPACE_ID env var. Omit to use the current workspace context.'
    ),
  },
  async ({ message, session_id, user_id, workspace }) => {
    const { answer, cards } = await collectQuery(message, session_id, user_id ?? 'default', workspace);

    let text = answer || '(Amphion returned an empty response)';

    if (cards.length > 0) {
      const citationLines = cards
        .slice(0, 8)
        .map((c, i) => {
          const title = c.title ?? c.source ?? c.filename ?? 'source';
          const score = c.score != null ? ` (score: ${c.score.toFixed(2)})` : '';
          return `[${i + 1}] ${title}${score}`;
        });
      text += `\n\n**Sources:**\n${citationLines.join('\n')}`;
    }

    return { content: [{ type: 'text', text }] };
  }
);

// ── Tool: amphion_learn ───────────────────────────────────────────────────────

server.tool(
  'amphion_learn',
  'Ask Amphion to research a topic and store it in its knowledge base. Provide URLs as sources so Amphion knows what to fetch — without sources the plan will stall. Example: sources: ["https://spec.modelcontextprotocol.io", "https://example.com/doc"].',
  {
    request: z.string().describe('What to research or learn. Be specific.'),
    sources: z.array(z.string()).optional().describe(
      'URLs to fetch and ingest. Provide at least one — without sources the plan cannot execute.'
    ),
    corpus: z.string().optional().describe(
      'Knowledge corpus to store results in. Examples: "research", "legal", "technical", "code". Defaults to "research".'
    ),
    title: z.string().optional().describe('Short title for the learn plan. Auto-generated if omitted.'),
    user_id: z.string().optional().describe('User ID. Defaults to "default".'),
  },
  async ({ request, sources, corpus, title, user_id }) => {
    const res = await fetch(`${BROKER_URL}/learn`, {
      method: 'POST',
      headers: brokerHeaders(),
      body: JSON.stringify({
        request,
        sources: sources ?? [],
        corpus: corpus ?? 'research',
        title: title ?? undefined,
        userId: user_id ?? 'default',
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? data.message ?? `HTTP ${res.status}`);

    const planId = data.id ?? data.planId ?? data.plan?.id ?? '(unknown)';
    const status = data.status ?? data.plan?.status ?? 'draft';
    const queuedSources = data.findings?.queued_source_count ?? data.plan?.findings?.queued_source_count ?? 0;

    return {
      content: [{
        type: 'text',
        text: [
          `Learn plan created: ${planId}`,
          `Status: ${status}`,
          `Corpus: ${corpus ?? 'research'}`,
          `Sources queued: ${queuedSources}`,
          queuedSources === 0
            ? '\nWARNING: No sources were queued. The plan will stall until sources are added. Retry with a sources: ["url1", "url2"] argument.'
            : '\nAmphion will research and ingest these sources. Query amphion_query later to access the results.',
        ].join('\n'),
      }],
    };
  }
);

// ── Tool: ppm_status ─────────────────────────────────────────────────────────

server.tool(
  'ppm_status',
  'Get the health and status of all services running under PPM (PersonalProjectManager) on miracle. Returns service name, alive/dead status, health score, port, and last heartbeat time.',
  {},
  async () => {
    const res = await fetch(`${PPM_URL}/api/projects`);
    if (!res.ok) throw new Error(`PPM /api/projects returned ${res.status}`);
    const projects = await res.json();

    if (!projects.length) {
      return { content: [{ type: 'text', text: 'No services currently registered with PPM.' }] };
    }

    const lines = projects.map(p => {
      const status = p.status ?? 'unknown';
      const health = p.health?.status ?? 'unknown';
      const score = p.health?.score ?? '?';
      const port = p.port ?? '?';
      const hbAgo = p.last_heartbeat
        ? `${Math.round((Date.now() - new Date(p.last_heartbeat)) / 1000)}s ago`
        : 'never';
      const caps = Array.isArray(p.capabilities) && p.capabilities.length
        ? `  caps: ${p.capabilities.join(', ')}`
        : '';
      return `${p.name} (${p.id})\n  status: ${status} | health: ${health} (${score}/100) | port: ${port} | heartbeat: ${hbAgo}${caps}`;
    });

    return {
      content: [{
        type: 'text',
        text: `PPM Services (${projects.length}):\n\n${lines.join('\n\n')}`,
      }],
    };
  }
);

// ── Tool: ppm_logs ────────────────────────────────────────────────────────────

server.tool(
  'ppm_logs',
  'Get recent events for a specific PPM service. Shows the last N events — heartbeats, commands, errors, and status changes. Use ppm_status first to find the service name or ID.',
  {
    project: z.string().describe(
      'Service name (e.g. "lichess-bot") or project ID (e.g. "proj_2ba591"). Partial name matching is supported.'
    ),
    limit: z.number().optional().describe('Number of recent events to return. Defaults to 20.'),
  },
  async ({ project, limit }) => {
    const projectId = await resolvePpmId(project);
    const n = limit ?? 20;

    // /events is SSE (streaming) — use /overview which returns activity as JSON
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 8000);
    const res = await fetch(`${PPM_URL}/api/projects/${projectId}/overview`, { signal: ac.signal });
    if (!res.ok) throw new Error(`PPM /overview returned ${res.status} for ${projectId}`);

    const data = await res.json().catch(() => ({}));
    const events = (data.activity ?? []).slice(0, n);

    if (!events.length) {
      return { content: [{ type: 'text', text: `No activity found for ${project}` }] };
    }

    const lines = events.map(e => {
      const ts = e.created_at
        ? new Date(e.created_at).toLocaleTimeString('en-US', { hour12: false })
        : '';
      const type = e.type ?? 'event';
      const severity = e.severity ? ` [${e.severity}]` : '';
      const payload = e.payload
        ? (typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload))
        : '';
      return `[${ts}]${severity} ${type}: ${payload}`;
    });

    return {
      content: [{
        type: 'text',
        text: `Events for ${project} (${lines.length}):\n\n${lines.join('\n')}`,
      }],
    };
  }
);

// ── Tool: list_workspaces ────────────────────────────────────────────────────

server.tool(
  'list_workspaces',
  'List all workspaces registered in Amphion\'s workspace registry. Returns name, path, language, description, and PPM service for each project on miracle. Use this to discover available workspace IDs for scoping queries.',
  {},
  async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 8000);
    const res = await fetch(`${BROKER_URL}/workspaces`, {
      headers: brokerHeaders(),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`Broker /workspaces returned ${res.status}`);
    const data = await res.json().catch(() => ({}));
    const workspaces = data.workspaces ?? [];

    if (!workspaces.length) {
      return { content: [{ type: 'text', text: 'No workspaces registered. Run: node amphion/scripts/seed-workspaces.js' }] };
    }

    const active = DEFAULT_WORKSPACE ? `\nActive workspace (this session): ${DEFAULT_WORKSPACE}\n` : '';
    const lines = workspaces.map(w => {
      const lang = w.language ? ` [${w.language}]` : '';
      const ppm  = w.ppmService ? ` | PPM: ${w.ppmService}` : '';
      const build = w.buildCmd ? ` | build: ${w.buildCmd}` : '';
      return `• ${w.id}${lang}${ppm}${build}\n  ${w.description ?? ''}\n  Path: ${w.path}`;
    });

    return {
      content: [{
        type: 'text',
        text: `Registered workspaces (${workspaces.length}):${active}\n${lines.join('\n\n')}`,
      }],
    };
  }
);

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
