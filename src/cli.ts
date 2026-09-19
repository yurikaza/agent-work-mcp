#!/usr/bin/env node
import { join, resolve } from 'node:path';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { FileSessionRepository } from './adapters/persistence/file-repository.js';
import { GitDocsProjectInspector } from './adapters/project/git-docs-inspector.js';
import { Orchestrator } from './core/orchestrator.js';
import { createMcpServer } from './mcp/server.js';
import { VERSION } from './version.js';

const HELP = `agent-work-mcp ${VERSION}
MCP server (stdio) for agent work orchestration: OUTSIDE_MODE (bounded autonomy) and DESK_MODE (human in the loop).

Usage: agent-work-mcp [--version] [--help]

Environment:
  AGENT_WORK_PROJECT_ROOT  default project root for new sessions (default: current directory)
  AGENT_WORK_STATE_DIR     where session state is stored (default: <project root>/.agent-work)
`;

const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(HELP);
  process.exit(0);
}

const projectRoot = resolve(process.env.AGENT_WORK_PROJECT_ROOT ?? process.cwd());
const stateDir = resolve(process.env.AGENT_WORK_STATE_DIR ?? join(projectRoot, '.agent-work'));

const orchestrator = new Orchestrator({
  repository: new FileSessionRepository(stateDir),
  inspector: new GitDocsProjectInspector(),
  defaultProjectRoot: projectRoot,
});

// stdout carries the protocol; diagnostics go to stderr.
process.stderr.write(`agent-work-mcp ${VERSION} · state: ${stateDir}\n`);
serveStdio(() => createMcpServer(orchestrator), {
  onerror: (e) => process.stderr.write(`agent-work-mcp: ${e.message}\n`),
});
