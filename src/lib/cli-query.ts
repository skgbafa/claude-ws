/**
 * CLI Query Utility - Lightweight one-shot CLI spawner
 *
 * Used by inline-edit-manager and git/generate-message for simple
 * prompt → response workflows without tool interception.
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { join, normalize } from 'path';
import { createLogger } from './logger';

const log = createLogger('CliQuery');

/**
 * Find the Claude CLI executable path
 */
export function findClaudePath(): string | undefined {
  // Check environment variable first
  const envPath = process.env.CLAUDE_PATH;
  if (envPath) {
    const normalized = normalize(envPath);
    if (existsSync(normalized)) return normalized;
  }

  const isWindows = process.platform === 'win32';
  const home = process.env.USERPROFILE || process.env.HOME || '';

  const candidates = isWindows
    ? [
        join(home, '.local', 'bin', 'claude.exe'),
        join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
        join(home, 'AppData', 'Local', 'Programs', 'claude', 'claude.exe'),
      ]
    : [
        `/home/${process.env.USER || 'user'}/.local/bin/claude`,
        '/usr/local/bin/claude',
        '/opt/homebrew/bin/claude',
      ];

  const found = candidates.find(p => existsSync(p));
  if (found) return found;

  // Fallback: use which/where to find claude on PATH (covers nvm, etc.)
  try {
    const cmd = isWindows ? 'where claude' : 'which claude';
    const result = execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim().split('\n')[0];
    if (result && existsSync(result)) return result;
  } catch {
    // which/where failed — claude not on PATH
  }

  return undefined;
}

export interface CliQueryOptions {
  prompt: string;
  cwd: string;
  model?: string; // Full model ID (e.g., 'claude-sonnet-4-5-20250929')
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
  maxTurns?: number;
}

export interface CliQueryResult {
  text: string;
  sessionId?: string;
}

/**
 * Run a one-shot CLI query.
 * Spawns `claude -p <prompt>` with stream-json output and accumulates the response.
 */
export async function cliQuery(options: CliQueryOptions): Promise<CliQueryResult> {
  const { prompt, cwd, model, onDelta, signal, maxTurns } = options;

  const claudePath = findClaudePath();
  if (!claudePath) {
    throw new Error('Claude CLI not found. Set CLAUDE_PATH in your .env file.');
  }

  const args: string[] = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
  ];

  if (model) {
    args.push('--model', model);
  }

  if (maxTurns) {
    args.push('--max-turns', String(maxTurns));
  }

  return new Promise<CliQueryResult>((resolve, reject) => {
    let child: ChildProcess;

    try {
      child = spawn(claudePath, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          NO_COLOR: '1',
          TERM: 'dumb',
          PATH: process.platform === 'win32'
            ? (process.env.PATH || '').split(';').filter(p => {
                const lp = p.toLowerCase().trim().replace(/\//g, '\\');
                return !lp.startsWith('c:\\windows') &&
                  !lp.startsWith('c:\\program files (x86)\\windows kits');
              }).join(';')
            : `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin`,
        },
      });
    } catch (err) {
      reject(err);
      return;
    }

    let buffer = '';
    let textResult = '';
    let sessionId: string | undefined;

    // Handle abort signal
    if (signal) {
      const onAbort = () => {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 3000);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      child.on('exit', () => signal.removeEventListener('abort', onAbort));
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);

          // Capture session ID
          if (msg.type === 'system' && msg.session_id) {
            sessionId = msg.session_id;
          }

          // Stream text deltas
          if (msg.type === 'content_block_delta' && msg.delta?.type === 'text_delta' && msg.delta.text) {
            textResult += msg.delta.text;
            onDelta?.(msg.delta.text);
          }

          // Handle assistant text blocks (non-streaming fallback)
          if (msg.type === 'assistant' && msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === 'text' && block.text) {
                if (!textResult.includes(block.text)) {
                  textResult = block.text;
                }
              }
            }
          }
        } catch {
          // Ignore non-JSON lines
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      log.debug({ stderr: chunk.toString().substring(0, 200) }, 'CLI stderr');
    });

    child.on('error', (err) => {
      reject(err);
    });

    child.on('exit', (code) => {
      // Process remaining buffer
      if (buffer.trim()) {
        try {
          const msg = JSON.parse(buffer);
          if (msg.type === 'assistant' && msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === 'text' && block.text && !textResult.includes(block.text)) {
                textResult = block.text;
              }
            }
          }
        } catch {
          // Ignore
        }
      }

      if (signal?.aborted) {
        reject(new Error('Query aborted'));
        return;
      }

      if (code !== 0 && code !== null && !textResult) {
        reject(new Error(`CLI exited with code ${code}`));
        return;
      }

      resolve({ text: textResult, sessionId });
    });
  });
}
