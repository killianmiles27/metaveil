#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ConfigError } from './config.js';
import { TokenStore } from './token-store.js';
import { NullAuditLog, printAuditSummary } from './audit.js';
import { createDetectors } from './detectors/index.js';
import { createPipeline } from './pipeline.js';
import { createRedactor } from './redact.js';
import { createProxyServer } from './server.js';

function usage() {
  return `metaveil - local redaction proxy for Muse Code

Usage:
  node src/cli.js serve --config <path>
  node src/cli.js audit [--config <path>] [--audit-path <path>]
  node src/cli.js scan <file> --config <path> [--contributor 0|1]

Commands:
  serve    Bind 127.0.0.1 and proxy the allowlisted Muse endpoints
  audit    Print a summary of the JSONL audit log
  scan     Dry-run redaction on a file and print the redacted text

Config keys are documented in README.md and config.example.json.
`;
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const without = arg.slice(2);
      const eq = without.indexOf('=');
      if (eq !== -1) {
        flags[without.slice(0, eq)] = without.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[without] = next;
          i += 1;
        } else {
          flags[without] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function requireConfig(flags) {
  if (!flags.config || typeof flags.config !== 'string') {
    throw new ConfigError('--config <path> is required');
  }
  return loadConfig(flags.config);
}

async function runServe(flags) {
  const config = requireConfig(flags);
  const proxy = await createProxyServer({ config });
  const { url } = await proxy.listen(config.port);
  process.stdout.write(`metaveil listening on ${url} (upstream ${config.upstream})\n`);
  const shutdown = async () => {
    try {
      await proxy.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function runAudit(flags) {
  if (typeof flags['audit-path'] === 'string') {
    printAuditSummary(path.resolve(flags['audit-path']));
    return;
  }
  const config = requireConfig(flags);
  printAuditSummary(config.auditPath);
}

async function runScan(flags, positional) {
  const file = positional[0];
  if (!file) throw new ConfigError('scan requires a file path');
  const config = requireConfig(flags);
  const store = await TokenStore.open({ mapPath: config.mapPath, persist: false });
  const pipeline = createPipeline({ config, detectors: createDetectors(config) });
  const redactor = createRedactor({ config, store, pipeline, audit: new NullAuditLog() });
  const contributor = flags.contributor === '1' || flags.contributor === true;
  const input = fs.readFileSync(file, 'utf8');
  const output = await redactor.redactText(input, {
    requestId: 'scan',
    contributor,
    field: 'scan',
  });
  process.stdout.write(output);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  if (!command || flags.help || command === 'help') {
    process.stdout.write(usage());
    process.exit(command && command !== 'help' ? 0 : 1);
  }
  if (command === 'serve') {
    await runServe(flags);
    return;
  }
  if (command === 'audit') {
    await runAudit(flags);
    return;
  }
  if (command === 'scan') {
    await runScan(flags, positional);
    return;
  }
  process.stderr.write(`metaveil: unknown command: ${command}\n\n${usage()}`);
  process.exit(1);
}

main().catch((error) => {
  const message = error instanceof ConfigError ? error.message : (error.code ? `${error.code}: ${error.message}` : error.message);
  process.stderr.write(`metaveil: ${message}\n`);
  process.exit(1);
});
