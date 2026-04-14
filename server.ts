// Load .env from user's CWD (where they ran claude-ws), not packageRoot
import { config as dotenvConfig } from 'dotenv';
import { join } from 'path';
const userCwd = process.env.CLAUDE_WS_USER_CWD || process.cwd();
dotenvConfig({ path: join(userCwd, '.env') });

// Load ~/.claude/settings.json env vars as fallback
// This ensures SDK subprocess has API key even if not in .env
import { applyClaudeCodeSettingsFallback } from './src/lib/claude-code-settings';
applyClaudeCodeSettingsFallback();

// Initialize Anthropic proxy BEFORE importing agent-manager or SDK
// This redirects all Anthropic API calls through our proxy for token caching
import { initAnthropicProxy } from './src/lib/anthropic-proxy-setup';
initAnthropicProxy();

// Import logCacheStats from shared cache module for monitoring
import { logCacheStats } from './src/lib/proxy-token-cache';

// Enable SDK file checkpointing globally
process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = '1';

// Unset CLAUDECODE to prevent nested session detection (SDK v0.2.42+)
// claude-ws spawns Claude CLI from a server process that may itself run inside Claude Code
delete process.env.CLAUDECODE;

// Run incremental data migrations (DB schema, config/data folder changes)
import { runMigrations } from './src/lib/migrations/migration-runner';
runMigrations();

import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { Server as SocketIOServer } from 'socket.io';
import { homedir } from 'os';
import { agentManager } from './src/lib/agent-manager';
import { sessionManager } from './src/lib/session-manager';
import { checkpointManager } from './src/lib/checkpoint-manager';
import { inlineEditManager } from './src/lib/inline-edit-manager';
import { shellManager } from './src/lib/shell-manager';
import { terminalManager } from './src/lib/terminal-manager';
import { db, schema } from './src/lib/db';
import { createLogger } from './src/lib/logger';
import { safeCompare } from './src/lib/timing-safe-compare';
import {
  sessionStore,
  isSiweEnabled,
  SIWE_SESSION_COOKIE_NAME,
} from './src/lib/siwe-session';

const log = createLogger('Server');
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { AttemptStatus } from './src/types';
import { processAttachments } from './src/lib/file-processor';
import { usageTracker } from './src/lib/usage-tracker';
import { workflowTracker } from './src/lib/workflow-tracker';
import { gitStatsCache } from './src/lib/git-stats-collector';
import { tunnelService } from './src/lib/tunnel-service';
import { getMinioPullQueueWorker } from './src/lib/minio-pull-queue';
import { getMinioPushQueueWorker } from './src/lib/minio-push-queue';
import { createAutopilotManager, appendQuestionAnswer, appendSubagentEnded, appendTrackedTaskUpdate } from './src/lib/autopilot';
import type { AutopilotMode } from './src/lib/autopilot';

import { getPort, getHostname } from './src/lib/server-port-configuration';

function isSqliteForeignKeyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const maybeError = error as { code?: string; message?: string };
  return maybeError.code === 'SQLITE_CONSTRAINT_FOREIGNKEY'
    || (typeof maybeError.message === 'string' && maybeError.message.includes('FOREIGN KEY constraint failed'));
}

const dev = process.env.NODE_ENV !== 'production';
const hostname = getHostname();
const port = getPort();

const app = next({ dev, hostname, port, turbopack: false });
const handle = app.getRequestHandler();
const minioPullQueueWorker = getMinioPullQueueWorker();
const minioPushQueueWorker = getMinioPushQueueWorker();

app.prepare().then(async () => {
  const httpServer = createServer((req, res) => {
    const parsedUrl = parse(req.url!, true);
    const pathname = parsedUrl.pathname || '';
    const requestStartedAt = Date.now();
    const shouldTraceRequest =
      pathname.startsWith('/api/attempts')
      || pathname.includes('/conversation')
      || pathname.includes('/running-attempt')
      || pathname.includes('/pending-question')
      || pathname.includes('/agent-factory/projects/');

    if (shouldTraceRequest) {
      res.on('finish', () => {
        const durationMs = Date.now() - requestStartedAt;
        log.info({
          method: req.method,
          path: pathname,
          statusCode: res.statusCode,
          durationMs,
          hasApiKey: Boolean(req.headers['x-api-key']),
        }, '[Server] HTTP request traced');
      });
    }

    // API authentication check - read from process.env directly for immediate effect
    const apiAccessKey = process.env.API_ACCESS_KEY;
    const siweEnabled = isSiweEnabled();
    const isApiRoute = pathname.startsWith('/api/');
    const isVerifyEndpoint = pathname === '/api/auth/verify';
    const isProxyEndpoint = pathname.startsWith('/api/proxy/anthropic');
    const isTunnelStatusEndpoint = pathname === '/api/tunnel/status';
    const isApiAccessKeyEndpoint = pathname === '/api/settings/api-access-key';
    const isSiweAuthEndpoint = pathname === '/api/auth/challenge' || pathname === '/api/auth/siwe';
    // Uploads GET is public (for serving files), POST/DELETE require API key
    const isUploadsGetEndpoint = pathname.startsWith('/api/uploads/') && req.method === 'GET';

    // Auth is "configured" if either API key or SIWE accepted addresses is set
    const authConfigured = (apiAccessKey && apiAccessKey.length > 0) || siweEnabled;

    // Skip auth for whitelisted endpoints
    if (isApiRoute && !isVerifyEndpoint && !isProxyEndpoint && !isTunnelStatusEndpoint && !isApiAccessKeyEndpoint && !isUploadsGetEndpoint && !isSiweAuthEndpoint && authConfigured) {
      let authenticated = false;

      // Check API key
      const providedKey = req.headers['x-api-key'];
      if (providedKey && typeof providedKey === 'string' && apiAccessKey && safeCompare(providedKey, apiAccessKey)) {
        authenticated = true;
      }

      // Check SIWE session cookie
      if (!authenticated) {
        const cookieHeader = req.headers.cookie;
        if (cookieHeader) {
          const sessionToken = cookieHeader
            .split(';')
            .map((c) => c.trim())
            .find((c) => c.startsWith(`${SIWE_SESSION_COOKIE_NAME}=`));
          if (sessionToken) {
            const token = sessionToken.slice(`${SIWE_SESSION_COOKIE_NAME}=`.length);
            const address = sessionStore.verify(token);
            if (address) {
              authenticated = true;
            }
          }
        }
      }

      if (!authenticated) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized', message: 'Valid API key or session required' }));
        return;
      }
    }

    handle(req, res, parsedUrl);
  });

  // Restore running shells from database (survives server restarts)
  const runningShells = await db.query.shells.findMany({
    where: eq(schema.shells.status, 'running'),
  });

  for (const shell of runningShells) {
    const restored = shellManager.restoreFromDb(shell);
    if (!restored) {
      // Shell is no longer running, update database
      await db.update(schema.shells)
        .set({ status: 'crashed', stoppedAt: Date.now() })
        .where(eq(schema.shells.id, shell.id));
    }
  }

  log.info(`[Server] Restored ${shellManager.runningCount} running shells`);

  // Initialize Autopilot Manager
  const autopilotManager = createAutopilotManager();
  autopilotManager.registerQuestionListener(agentManager);

  // Initialize Socket.io
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: dev
        ? ['http://localhost:3000', 'http://127.0.0.1:3000', ...(process.env.CORS_ORIGIN ? [process.env.CORS_ORIGIN] : [])]
        : (process.env.CORS_ORIGIN ? [process.env.CORS_ORIGIN] : false),
    },
    // Keep connections alive through Cloudflare Tunnel (100s idle timeout)
    pingInterval: 10000,
    pingTimeout: 10000,
  });

  // Restore autopilot state from DB (needs io for worker callbacks)
  await autopilotManager.restoreFromDb({ db, io, schema, agentManager, sessionManager });

  // Disconnect cleanup timers - keyed by attemptId
  const disconnectTimers = new Map<string, NodeJS.Timeout>();

  // Terminal rate limiting - max terminals per socket
  const MAX_TERMINALS_PER_SOCKET = 5;
  const socketTerminals = new Map<string, Set<string>>();

  // Socket.io connection handler
  io.on('connection', (socket) => {
    log.info(`Client connected: ${socket.id}`);

    // Start new attempt
    socket.on(
      'attempt:start',
      async (data: {
        taskId: string;
        prompt: string;
        displayPrompt?: string;
        fileIds?: string[];
        force_create?: boolean;
        projectId?: string;
        projectName?: string;
        taskTitle?: string;
        projectRootPath?: string;
        outputFormat?: 'json' | 'html' | 'markdown' | 'yaml' | 'raw' | 'custom';
        outputSchema?: string;
        model?: string;  // Optional: model ID for this attempt
        provider?: 'claude-cli' | 'claude-sdk';  // Optional: provider for this attempt
      }) => {
        const {
          taskId,
          prompt,
          displayPrompt,
          fileIds = [],
          force_create,
          projectId,
          projectName,
          taskTitle,
          projectRootPath,
          outputFormat,
          outputSchema,
          model,
          provider
        } = data;

        log.info({
          taskId,
          prompt,
          force_create,
          projectId,
          projectName,
          taskTitle,
          projectRootPath,
          outputFormat,
          hasOutputSchema: !!outputSchema,
          model,
          provider,
        }, '[Socket] attempt:start received');

        try {
          let task = await db.query.tasks.findFirst({
            where: eq(schema.tasks.id, taskId),
          });

          // Handle force_create logic
          if (force_create && !task) {
            log.info('[Socket] Task not found, force_create=true');

            if (!projectId) {
              socket.emit('error', { message: 'projectId required' });
              return;
            }

            // Check if project exists
            let project = await db.query.projects.findFirst({
              where: eq(schema.projects.id, projectId),
            });

            log.info({ exists: !!project }, '[Socket] Project exists?');

            // Create project if it doesn't exist
            if (!project) {
              log.info('[Socket] Project does not exist, checking projectName...');
              log.info({ projectName }, '[Socket] projectName value');

              if (!projectName || projectName.trim() === '') {
                log.info('[Socket] Project name required but not provided');
                socket.emit('error', { message: 'projectName required' });
                return;
              }

              // Create project directory and record
              const { mkdir } = await import('fs/promises');
              const { join } = await import('path');

              const projectDirName = `${projectId}-${projectName}`;
              log.info({ projectRootPath, userCwd, projectDirName }, '[Socket] Debug project path creation');
              const projectPath = (projectRootPath && projectRootPath.trim() !== '')
                ? join(projectRootPath, projectDirName)
                : join(userCwd, 'data', 'projects', projectDirName);
              log.info({ projectPath, projectRootPath, userCwd }, '[Socket] Final project path');

              try {
                const { setupProjectDefaults } = await import('./src/lib/project-utils');
                await mkdir(projectPath, { recursive: true });
                await setupProjectDefaults(projectPath, projectId);
                log.info({ projectPath, projectId }, '[Socket] Created project directory and defaults');
              } catch (mkdirError: any) {
                if (mkdirError?.code !== 'EEXIST') {
                  log.error({ mkdirError }, '[Socket] Failed to create project folder');
                  socket.emit('error', { message: 'Failed to create project folder: ' + mkdirError.message });
                  return;
                }
              }

              try {
                await db.insert(schema.projects).values({
                  id: projectId,
                  name: projectName,
                  path: projectPath,
                  createdAt: Date.now(),
                });
                log.info({ projectId }, '[Socket] Created project');
              } catch (error) {
                log.error({ error }, '[Socket] Failed to create project');
                socket.emit('error', { message: 'Failed to create project' });
                return;
              }

              // Project created, fetch it
              project = await db.query.projects.findFirst({
                where: eq(schema.projects.id, projectId),
              });
            }

            // Check taskTitle
            if (!taskTitle || taskTitle.trim() === '') {
              log.info('[Socket] Task title required but not provided');
              socket.emit('error', { message: 'taskTitle required' });
              return;
            }

            // Create task
            const { and, desc } = await import('drizzle-orm');

            // Get next position for todo status
            const tasksInStatus = await db
              .select()
              .from(schema.tasks)
              .where(
                and(
                  eq(schema.tasks.projectId, projectId),
                  eq(schema.tasks.status, 'todo')
                )
              )
              .orderBy(desc(schema.tasks.position))
              .limit(1);

            const position = tasksInStatus.length > 0 ? tasksInStatus[0].position + 1 : 0;

            try {
              await db.insert(schema.tasks).values({
                id: taskId,
                projectId,
                title: taskTitle,
                description: null,
                status: 'todo',
                position,
                chatInit: false,
                rewindSessionId: null,
                rewindMessageUuid: null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              });
              log.info({ taskId }, '[Socket] Created task');

              // Fetch the created task
              task = await db.query.tasks.findFirst({
                where: eq(schema.tasks.id, taskId),
              });
            } catch (error) {
              log.error({ error }, '[Socket] Failed to create task');
              socket.emit('error', { message: 'Failed to create task' });
              return;
            }
          }

          // Validate task exists
          if (!task) {
            socket.emit('error', { message: 'Task not found' });
            return;
          }

          // Get project info
          const project = await db.query.projects.findFirst({
            where: eq(schema.projects.id, task.projectId),
          });

          if (!project) {
            socket.emit('error', { message: 'Project not found' });
            return;
          }

          // Get session options for conversation continuation
          // Uses auto-fix to detect and skip past API errors in corrupted sessions
          const sessionOptions = await sessionManager.getSessionOptionsWithAutoFix(taskId);

          // Create attempt record
          const attemptId = nanoid();

          await db.insert(schema.attempts).values({
            id: attemptId,
            taskId,
            prompt,
            displayPrompt: displayPrompt || null,
            status: 'running',
            outputFormat: outputFormat || null,
            outputSchema: outputSchema || null,
          });


          // Process file attachments if any
          // Merge fileIds from socket payload with pending fileIds stored on the task
          let allFileIds = [...fileIds];
          if (task.pendingFileIds) {
            try {
              const dbEntries = JSON.parse(task.pendingFileIds) as (string | { tempId: string })[];
              for (const entry of dbEntries) {
                const id = typeof entry === 'string' ? entry : entry.tempId;
                if (id && !allFileIds.includes(id)) allFileIds.push(id);
              }
            } catch { /* ignore parse errors */ }
          }

          let filePaths: string[] = [];
          if (allFileIds.length > 0) {
            log.info(`[Server] Processing ${allFileIds.length} file attachments for attempt ${attemptId}`);
            const processedFiles = await processAttachments(attemptId, allFileIds);
            filePaths = processedFiles.map(f => f.absolutePath);
            log.info(`[Server] Processed ${processedFiles.length} files`);
          }

          // Update task status to in_progress if it was todo
          // Also clear pendingFileIds since they've been processed
          const taskUpdates: any = { updatedAt: Date.now() };
          if (task.status === 'todo') taskUpdates.status = 'in_progress';
          if (task.pendingFileIds) taskUpdates.pendingFileIds = null;
          if (Object.keys(taskUpdates).length > 1) {
            await db
              .update(schema.tasks)
              .set(taskUpdates)
              .where(eq(schema.tasks.id, taskId));
          }

          // Join attempt room
          socket.join(`attempt:${attemptId}`);

          // Start Claude Agent SDK query

          agentManager.start({
            attemptId,
            projectPath: project.path,
            prompt,
            model: model || undefined,
            provider: provider || undefined,
            sessionOptions: Object.keys(sessionOptions).length > 0 ? sessionOptions : undefined,
            filePaths: filePaths.length > 0 ? filePaths : undefined,
            outputFormat,
            outputSchema,
          });

          // Log session mode
          const sessionMode = sessionOptions.resumeSessionAt
            ? `resuming at message ${sessionOptions.resumeSessionAt}`
            : sessionOptions.resume
              ? `resuming session ${sessionOptions.resume}`
              : 'new session';

          log.info(`[Server] Started attempt ${attemptId} (${sessionMode})${filePaths.length > 0 ? ` with ${filePaths.length} files` : ''}`);

          socket.emit('attempt:started', { attemptId, taskId, outputFormat, outputSchema });

          // Global event for all clients to track running tasks
          io.emit('task:started', { taskId });
        } catch (error) {
          log.error({ error }, 'Error starting attempt');
          socket.emit('error', {
            message: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }
    );

    // Cancel/kill attempt
    socket.on('attempt:cancel', async (data: { attemptId: string }) => {
      const { attemptId } = data;

      // Try to cancel in-memory agent (may not exist if server restarted)
      agentManager.cancel(attemptId);

      // Always update DB status - handles both in-memory and stale attempts
      // Get attempt to retrieve taskId for global event
      const attempt = await db.query.attempts.findFirst({
        where: eq(schema.attempts.id, attemptId),
      });

      if (attempt && attempt.status === 'running') {
        await db
          .update(schema.attempts)
          .set({ status: 'cancelled', completedAt: Date.now() })
          .where(eq(schema.attempts.id, attemptId));

        // Clear checkpoint tracking
        checkpointManager.clearAttemptCheckpoint(attemptId);

        io.to(`attempt:${attemptId}`).emit('attempt:finished', {
          attemptId,
          status: 'cancelled',
          code: null,
        });

        // Global event for all clients to track cancelled tasks
        if (attempt.taskId) {
          io.emit('task:finished', { taskId: attempt.taskId, status: 'cancelled' });
        }
      }
    });

    // Subscribe to attempt logs
    socket.on('attempt:subscribe', (data: { attemptId: string }) => {
      log.info(`[Server] Socket ${socket.id} subscribing to attempt:${data.attemptId}`);
      socket.join(`attempt:${data.attemptId}`);

      // Clear disconnect timer if client reconnected
      const timer = disconnectTimers.get(data.attemptId);
      if (timer) {
        clearTimeout(timer);
        disconnectTimers.delete(data.attemptId);
        log.info({ attemptId: data.attemptId }, '[Server] Cleared disconnect timer on reconnect');
      }

      // Re-emit pending question to this socket if one exists
      // This ensures clients recover question state after task switches
      const pendingQ = agentManager.getPendingQuestionData(data.attemptId);
      if (pendingQ) {
        log.info({ attemptId: data.attemptId, toolUseId: pendingQ.toolUseId }, '[Server] Re-emitting pending question on subscribe');
        socket.emit('question:ask', {
          attemptId: data.attemptId,
          toolUseId: pendingQ.toolUseId,
          questions: pendingQ.questions,
        });
      }
    });

    // Unsubscribe from attempt logs
    socket.on('attempt:unsubscribe', (data: { attemptId: string }) => {
      socket.leave(`attempt:${data.attemptId}`);
    });

    // Dedup guard — prevent processing the same answer twice (React double-renders, reconnects)
    const answeredAttempts = new Set<string>();

    // Handle AskUserQuestion response - resolve pending canUseTool callback
    socket.on(
      'question:answer',
      async (data: { attemptId: string; toolUseId?: string; questions: unknown[]; answers: Record<string, string> }) => {
        const { attemptId, toolUseId, questions, answers } = data;

        const dedupKey = `${attemptId}:${toolUseId || ''}`;
        if (answeredAttempts.has(dedupKey)) {
          log.warn({ attemptId, toolUseId }, '[Server] Duplicate answer ignored');
          return;
        }
        answeredAttempts.add(dedupKey);
        setTimeout(() => answeredAttempts.delete(dedupKey), 30_000); // cleanup after 30s

        log.info({ attemptId, answers }, '[Server] Received answer');

        // Clear persistent question for this task (user has answered)
        // Also write Q&A to autopilot context file for task resume context
        try {
          const attempt = await db.query.attempts.findFirst({
            where: eq(schema.attempts.id, attemptId),
          });
          if (attempt) {
            agentManager.clearPersistentQuestion(attempt.taskId);

            // Append Q&A to autopilot context file (only for autopilot-managed tasks)
            const task = await db.query.tasks.findFirst({
              where: eq(schema.tasks.id, attempt.taskId),
            });
            if (task && autopilotManager.isEnabled(task.projectId)) {
              const project = await db.query.projects.findFirst({
                where: eq(schema.projects.id, task.projectId),
              });
              if (project?.path) {
                appendQuestionAnswer(project.path, attempt.taskId, questions as any[], answers);
              }
            }
          }
        } catch { /* non-critical */ }

        // Try to answer directly:
        // - SDK provider: resolves the blocking canUseTool Promise
        // - CLI provider: sends answer as follow-up text message via stdin
        let directlyAnswered = false;
        if (agentManager.hasPendingQuestion(attemptId) || agentManager.isRunning(attemptId)) {
          directlyAnswered = agentManager.answerQuestion(attemptId, toolUseId, questions, answers);
          if (directlyAnswered) {
            log.info(`[Server] Resumed streaming for ${attemptId}`);
          } else {
            log.warn(`[Server] Direct answer failed for ${attemptId}, falling through to auto-retry`);
          }
        }

        if (!directlyAnswered) {
          // No active session or direct answer failed — auto-retry with new attempt
          log.warn(`[Server] Auto-retrying answer for ${attemptId}`);

          try {
            // Look up the attempt to get taskId
            const attempt = await db.query.attempts.findFirst({
              where: eq(schema.attempts.id, attemptId),
            });

            if (!attempt) {
              socket.emit('error', { message: 'Attempt not found for auto-retry' });
              return;
            }

            // Look up the task to get projectId
            const task = await db.query.tasks.findFirst({
              where: eq(schema.tasks.id, attempt.taskId),
            });

            if (!task) {
              socket.emit('error', { message: 'Task not found for auto-retry' });
              return;
            }

            // Look up the project to get path
            const project = await db.query.projects.findFirst({
              where: eq(schema.projects.id, task.projectId),
            });

            if (!project) {
              socket.emit('error', { message: 'Project not found for auto-retry' });
              return;
            }

            // Get session options for conversation continuation
            const sessionOptions = await sessionManager.getSessionOptionsWithAutoFix(attempt.taskId);

            // If no resume session is available, we can't auto-retry
            if (!sessionOptions.resume && !sessionOptions.resumeSessionAt) {
              socket.emit('error', { message: 'No session available to resume - cannot auto-retry' });
              return;
            }

            // Format the answer as a prompt string
            const answerPrompt = `The user answered the previous question:\n${Object.entries(answers).map(([q, a]) => `Q: ${q}\nA: ${a}`).join('\n\n')}\n\nPlease continue.`;

            // Create a new attempt in the DB
            const newAttemptId = nanoid();
            await db.insert(schema.attempts).values({
              id: newAttemptId,
              taskId: attempt.taskId,
              prompt: answerPrompt,
              displayPrompt: 'Auto-retry: answer to previous question',
              status: 'running' as AttemptStatus,
            });

            // Join the socket to the new attempt room
            socket.join(`attempt:${newAttemptId}`);

            // Start the agent (preserve original model/provider from task)
            agentManager.start({
              attemptId: newAttemptId,
              projectPath: project.path,
              prompt: answerPrompt,
              model: task.lastModel || undefined,
              provider: (task.lastProvider as 'claude-cli' | 'claude-sdk') || undefined,
              sessionOptions,
            });

            // Emit attempt:started to the client so the UI knows a new attempt started
            socket.emit('attempt:started', { attemptId: newAttemptId, taskId: attempt.taskId });

            log.warn(`[Server] Auto-retried answer for ${attemptId} as new attempt ${newAttemptId}`);
          } catch (error) {
            log.error({ error }, `[Server] Auto-retry failed for ${attemptId}:`);
            socket.emit('error', { message: 'Auto-retry failed: ' + (error instanceof Error ? error.message : 'Unknown error') });
          }
        }
      }
    );

    // Handle AskUserQuestion cancellation
    socket.on(
      'question:cancel',
      async (data: { attemptId: string }) => {
        const { attemptId } = data;
        log.info(`[Server] Cancelling question for ${attemptId}`);

        if (agentManager.hasPendingQuestion(attemptId)) {
          agentManager.cancelQuestion(attemptId);
          log.info(`[Server] Question cancelled for ${attemptId}`);
        }
      }
    );

    // Handle manual compact request
    socket.on('attempt:compact', async (data: { taskId: string }) => {
      const { taskId: compactTaskId } = data;
      log.info({ taskId: compactTaskId }, '[Server] Manual compact requested');

      try {
        const task = await db.query.tasks.findFirst({
          where: eq(schema.tasks.id, compactTaskId),
        });
        if (!task) { socket.emit('error', { message: 'Task not found' }); return; }

        const project = await db.query.projects.findFirst({
          where: eq(schema.projects.id, task.projectId),
        });
        if (!project) { socket.emit('error', { message: 'Project not found' }); return; }

        const conversationSummary = await sessionManager.getConversationSummary(compactTaskId);

        const compactAttemptId = nanoid();
        await db.insert(schema.attempts).values({
          id: compactAttemptId,
          taskId: compactTaskId,
          prompt: 'Manual compact: summarize conversation context',
          displayPrompt: 'Compacting conversation...',
          status: 'running',
        });

        socket.join(`attempt:${compactAttemptId}`);
        socket.emit('attempt:started', { attemptId: compactAttemptId, taskId: compactTaskId });
        io.to(`attempt:${compactAttemptId}`).emit('context:compacting', { attemptId: compactAttemptId, taskId: compactTaskId });

        agentManager.compact({
          attemptId: compactAttemptId,
          projectPath: project.path,
          conversationSummary,
        });
      } catch (error) {
        log.error({ error }, '[Server] Manual compact failed');
        socket.emit('error', { message: 'Compact failed: ' + (error instanceof Error ? error.message : 'Unknown error') });
      }
    });

    // ========================================
    // Inline Edit Socket Handlers
    // ========================================

    // Subscribe to inline edit session (with acknowledgment)
    socket.on('inline-edit:subscribe', (data: { sessionId: string }, ack?: (ok: boolean) => void) => {
      log.info(`[Server] Socket ${socket.id} subscribing to inline-edit:${data.sessionId}`);
      socket.join(`inline-edit:${data.sessionId}`);
      // Send acknowledgment that subscription is complete
      if (ack) ack(true);
    });

    // Start inline edit session (moved from API route to avoid module context issues)
    socket.on('inline-edit:start', async (data: {
      sessionId: string;
      basePath: string;
      filePath: string;
      language: string;
      selectedCode: string;
      instruction: string;
    }, ack?: (result: { success: boolean; error?: string }) => void) => {
      log.info(`[Server] Starting inline edit session ${data.sessionId}`);
      try {
        await inlineEditManager.startEdit({
          sessionId: data.sessionId,
          basePath: data.basePath,
          filePath: data.filePath,
          language: data.language || 'text',
          selectedCode: data.selectedCode,
          instruction: data.instruction,
        });
        if (ack) ack({ success: true });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Failed to start edit';
        log.error({ errorMsg }, '[Server] Inline edit start error');
        if (ack) ack({ success: false, error: errorMsg });
      }
    });

    // Cancel inline edit session
    socket.on('inline-edit:cancel', (data: { sessionId: string }) => {
      log.info(`[Server] Cancelling inline edit session ${data.sessionId}`);
      inlineEditManager.cancelEdit(data.sessionId);
    });

    // ========================================
    // Shell Socket Handlers
    // ========================================

    // Subscribe to shell events for a project
    socket.on('shell:subscribe', (data: { projectId: string }) => {
      log.info(`[Server] Socket ${socket.id} subscribing to shell:project:${data.projectId}`);
      socket.join(`shell:project:${data.projectId}`);
    });

    // Unsubscribe from shell events
    socket.on('shell:unsubscribe', (data: { projectId: string }) => {
      socket.leave(`shell:project:${data.projectId}`);
    });

    // Stop a running shell
    socket.on('shell:stop', async (data: { shellId: string }, ack?: (result: { success: boolean; error?: string }) => void) => {
      log.info(`[Server] Stopping shell ${data.shellId}`);
      try {
        const success = shellManager.stop(data.shellId);
        if (success) {
          // Update database
          await db.update(schema.shells)
            .set({ status: 'stopped', stoppedAt: Date.now() })
            .where(eq(schema.shells.id, data.shellId));
        }
        if (ack) ack({ success });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Failed to stop shell';
        log.error({ errorMsg }, '[Server] Shell stop error');
        if (ack) ack({ success: false, error: errorMsg });
      }
    });

    // Get logs for a specific shell
    socket.on('shell:getLogs', (
      data: { shellId: string; lines?: number },
      ack?: (result: { logs: Array<{ type: 'stdout' | 'stderr'; content: string; timestamp: number }>; error?: string }) => void
    ) => {
      try {
        const logs = shellManager.getRecentLogs(data.shellId, data.lines || 100);
        if (ack) ack({ logs });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Failed to get logs';
        log.error({ errorMsg }, '[Server] Shell getLogs error');
        if (ack) ack({ logs: [], error: errorMsg });
      }
    });

    // ========================================
    // Interactive Terminal Socket Handlers
    // ========================================

    socket.on('terminal:create', async (
      data: { projectId?: string; cols?: number; rows?: number },
      ack?: (result: { success: boolean; terminalId?: string; error?: string }) => void
    ) => {
      log.info('[Server] Creating terminal session');

      // Rate limit: max terminals per socket
      const existingTerminals = socketTerminals.get(socket.id) || new Set();
      if (existingTerminals.size >= MAX_TERMINALS_PER_SOCKET) {
        if (ack) ack({ success: false, error: `Maximum ${MAX_TERMINALS_PER_SOCKET} terminals per connection` });
        return;
      }

      try {
        // Resolve CWD: try project path if projectId given, fallback to user CWD
        let cwd = userCwd;
        if (data.projectId) {
          const project = await db.query.projects.findFirst({
            where: eq(schema.projects.id, data.projectId),
          });
          if (project) cwd = project.path;
        }

        const terminalId = terminalManager.create({
          projectId: data.projectId || 'global',
          cwd,
          cols: data.cols,
          rows: data.rows,
        });

        socket.join(`terminal:${terminalId}`);
        if (!socketTerminals.has(socket.id)) {
          socketTerminals.set(socket.id, new Set());
        }
        socketTerminals.get(socket.id)!.add(terminalId);
        log.info({ terminalId, cwd }, '[Server] Terminal session created');
        if (ack) ack({ success: true, terminalId });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Failed to create terminal';
        log.error({ error: msg }, '[Server] Terminal create error');
        if (ack) ack({ success: false, error: msg });
      }
    });

    socket.on('terminal:input', (data: { terminalId: string; data: string }) => {
      terminalManager.write(data.terminalId, data.data);
    });

    socket.on('terminal:resize', (data: { terminalId: string; cols: number; rows: number }) => {
      terminalManager.resize(data.terminalId, data.cols, data.rows);
    });

    socket.on('terminal:close', (
      data: { terminalId: string },
      ack?: (result: { success: boolean }) => void
    ) => {
      log.info({ terminalId: data.terminalId }, '[Server] Closing terminal session');
      const success = terminalManager.destroy(data.terminalId);
      const terms = socketTerminals.get(socket.id);
      if (terms) terms.delete(data.terminalId);
      if (ack) ack({ success });
    });

    socket.on('terminal:subscribe', (data: { terminalId: string }) => {
      socket.join(`terminal:${data.terminalId}`);
    });

    socket.on('terminal:check', (
      data: { terminalId: string },
      ack?: (result: { alive: boolean }) => void
    ) => {
      const alive = terminalManager.has(data.terminalId);
      if (ack) ack({ alive });
    });

    // Autopilot handlers — primary: set-mode, with backward-compat aliases
    socket.on('autopilot:set-mode', async (data: { projectId: string; mode: string }) => {
      const { projectId, mode } = data;
      if (!['off', 'autonomous', 'ask'].includes(mode)) return;
      log.info({ projectId, mode }, '[Autopilot] Setting mode');
      await autopilotManager.setMode(projectId, mode as AutopilotMode, {
        db, io, schema, agentManager, sessionManager,
      });
    });

    // Backward compat: old enable = autonomous
    socket.on('autopilot:enable', async (data: { projectId: string }) => {
      log.info({ projectId: data.projectId }, '[Autopilot] Enable (compat → autonomous)');
      await autopilotManager.setMode(data.projectId, 'autonomous', {
        db, io, schema, agentManager, sessionManager,
      });
    });

    // Backward compat: old disable = off
    socket.on('autopilot:disable', async (data: { projectId: string }) => {
      log.info({ projectId: data.projectId }, '[Autopilot] Disable (compat → off)');
      await autopilotManager.setMode(data.projectId, 'off', {
        db, io, schema, agentManager, sessionManager,
      });
    });

    socket.on('autopilot:status-request', (data: { projectId: string }) => {
      const { projectId } = data;
      socket.emit('autopilot:status', {
        projectId,
        ...autopilotManager.getStatus(projectId),
      });
    });

    socket.on('disconnect', () => {
      log.info(`Client disconnected: ${socket.id}`);

      // Clean up terminals created by this socket
      const terms = socketTerminals.get(socket.id);
      if (terms) {
        for (const terminalId of terms) {
          terminalManager.destroy(terminalId);
        }
        socketTerminals.delete(socket.id);
      }

      // Find all attempt rooms this socket was in
      // Socket.io automatically removes the socket from rooms on disconnect
      // but we can check which rooms had this socket before disconnect
      const socketRooms = Array.from(socket.rooms || []);
      const attemptRooms = socketRooms
        .filter(room => room.startsWith('attempt:'))
        .map(room => room.replace('attempt:', ''));

      for (const attemptId of attemptRooms) {
        // Start grace timer for this attempt
        if (disconnectTimers.has(attemptId)) continue; // Already has a timer

        const timer = setTimeout(async () => {
          disconnectTimers.delete(attemptId);

          // Check if attempt room still has 0 clients
          const room = io.sockets.adapter.rooms.get(`attempt:${attemptId}`);
          if (room && room.size > 0) {
            log.info({ attemptId, clients: room.size }, '[Server] Attempt room still has clients, skipping cleanup');
            return;
          }

          // Check if attempt is still running
          if (!agentManager.isRunning(attemptId)) return;

          log.info({ attemptId }, '[Server] No clients for 30s, cancelling orphaned attempt');

          // Cancel the agent
          agentManager.cancel(attemptId);

          // Mark subagents as orphaned in DB
          try {
            await db.update(schema.subagents)
              .set({ status: 'orphaned', completedAt: Date.now() })
              .where(eq(schema.subagents.attemptId, attemptId));
          } catch (err) {
            log.error({ err, attemptId }, '[Server] Failed to mark subagents as orphaned on disconnect');
          }
        }, 30000);

        disconnectTimers.set(attemptId, timer);
      }
    });
  });

  // ========================================
  // Inline Edit Manager Event Handlers
  // ========================================
  log.info({ instanceId: (inlineEditManager as unknown as { _id?: string })._id }, '[Server] Setting up inlineEditManager event handlers');

  // Forward inline edit deltas to subscribers
  inlineEditManager.on('delta', ({ sessionId, chunk }) => {
    io.to(`inline-edit:${sessionId}`).emit('inline-edit:delta', { sessionId, chunk });
  });

  // Forward inline edit completion to subscribers
  inlineEditManager.on('complete', ({ sessionId, code, diff }) => {
    const room = `inline-edit:${sessionId}`;
    const sockets = io.sockets.adapter.rooms.get(room);
    log.info(`[Server] Inline edit ${sessionId} completed, ${code.length} chars, room ${room} has ${sockets?.size || 0} sockets`);
    io.to(room).emit('inline-edit:complete', { sessionId, code, diff });
  });

  // Forward inline edit errors to subscribers
  inlineEditManager.on('error', ({ sessionId, error }) => {
    log.error({ sessionId, error }, '[Server] Inline edit error');
    io.to(`inline-edit:${sessionId}`).emit('inline-edit:error', { sessionId, error });
  });

  // ========================================
  // Shell Manager Event Handlers
  // ========================================

  // Forward shell started events
  shellManager.on('started', ({ shellId, projectId, pid, command }) => {
    log.info(`[Server] Shell ${shellId} started with PID ${pid}`);
    io.to(`shell:project:${projectId}`).emit('shell:started', { shellId, projectId, pid, command });
  });

  // Forward shell output to subscribers
  shellManager.on('output', ({ shellId, projectId, type, content }) => {
    io.to(`shell:project:${projectId}`).emit('shell:output', { shellId, projectId, type, content });
  });

  // Forward shell exit events
  shellManager.on('exit', async ({ shellId, projectId, code, signal }) => {
    log.info(`[Server] Shell ${shellId} exited with code ${code}, signal ${signal}`);
    io.to(`shell:project:${projectId}`).emit('shell:exit', { shellId, projectId, code, signal });

    // Update database
    try {
      await db.update(schema.shells)
        .set({
          status: code === 0 ? 'stopped' : 'crashed',
          exitCode: code,
          exitSignal: signal,
          stoppedAt: Date.now(),
        })
        .where(eq(schema.shells.id, shellId));
    } catch (error) {
      log.error({ shellId, error }, '[Server] Failed to update shell in database');
    }
  });

  // ========================================
  // Terminal Manager Event Handlers
  // ========================================

  terminalManager.on('output', ({ terminalId, data }) => {
    io.to(`terminal:${terminalId}`).emit('terminal:output', { terminalId, data });
  });

  terminalManager.on('exit', ({ terminalId, exitCode, signal }) => {
    log.info({ terminalId, exitCode, signal }, '[Server] Terminal exited');
    io.to(`terminal:${terminalId}`).emit('terminal:exit', { terminalId, exitCode, signal });
  });

  // Forward AgentManager events to WebSocket clients
  agentManager.on('started', ({ attemptId, taskId }) => {
    log.info(`[Server] Agent started for attempt ${attemptId}, task ${taskId}`);
    // Emit to all clients so they can subscribe if they're viewing this task
    io.emit('attempt:started', { attemptId, taskId });
  });

  agentManager.on('json', async ({ attemptId, data }) => {
    // Skip saving streaming deltas - they're intermediate state
    // Complete assistant messages will have full text/thinking
    const isStreamingDelta = data.type === 'content_block_delta';

    if (!isStreamingDelta) {
      // Save to database (only complete messages)
      try {
        await db.insert(schema.attemptLogs).values({
          attemptId,
          type: 'json',
          content: JSON.stringify(data),
        });
      } catch (error) {
        if (isSqliteForeignKeyError(error)) {
          log.warn({ attemptId }, '[Server] Skipping JSON log write because attempt no longer exists');
        } else {
          throw error;
        }
      }
    }

    // Check how many clients are in the room
    const room = io.sockets.adapter.rooms.get(`attempt:${attemptId}`);
    const clientCount = room ? room.size : 0;
    if (!isStreamingDelta) {
      log.info(`[Server] Emitting output:json to attempt:${attemptId} (${clientCount} clients in room)`, data.type);
    }

    // TRANSFORM RESULT DATA
    let outputData: any = data;
    if (data.type === 'result') {
      // Log raw result to debug
      log.info('[Server] Raw Result Data:', JSON.stringify(data, null, 2));

      // Cast to any to inspect loose structure
      const resultData = data as any;

      // Check content property
      let contentStr = '';
      if (typeof resultData.content === 'string') {
        contentStr = resultData.content;
      } else if (resultData.text) {
        contentStr = resultData.text;
      } else if (resultData.message) { // Sometimes it might be in message?
        if (typeof resultData.message === 'string') contentStr = resultData.message;
        else if (resultData.message.content) contentStr = resultData.message.content; // text inside message object?
      }

      let outputContent: any = "Task completed. (No text content returned)";

      if (contentStr) {
        try {
          // Generic JSON parsing - if it looks like JSON, parse it
          // This handles both strict JSON content and some relaxed JSON
          const trimmed = contentStr.trim();
          if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
            (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
            outputContent = JSON.parse(trimmed);
          } else {
            // Check for markdown code blocks if the whole thing isn't JSON
            const jsonMatch = contentStr.match(/```json\n([\s\S]*?)\n```/);
            if (jsonMatch) {
              outputContent = JSON.parse(jsonMatch[1]);
            } else {
              outputContent = contentStr;
            }
          }
        } catch (e) {
          // Fallback to raw string if parsing fails
          outputContent = contentStr;
        }
      }

      outputData = {
        ...data,
        content: outputContent
      };
    }

    // Always forward to subscribers (for real-time streaming)
    io.to(`attempt:${attemptId}`).emit('output:json', { attemptId, data: outputData });
  });

  agentManager.on('stderr', async ({ attemptId, content }) => {
    try {
      await db.insert(schema.attemptLogs).values({
        attemptId,
        type: 'stderr',
        content,
      });
    } catch (error) {
      if (isSqliteForeignKeyError(error)) {
        log.warn({ attemptId }, '[Server] Skipping stderr log write because attempt no longer exists');
      } else {
        throw error;
      }
    }

    io.to(`attempt:${attemptId}`).emit('output:stderr', { attemptId, content });
  });

  // Handle AskUserQuestion detection from AgentManager
  agentManager.on('question', async ({ attemptId, toolUseId, questions }) => {
    log.info({
      attemptId,
      toolUseId,
      questionCount: questions?.length,
      questions: questions?.map((q: any) => ({ header: q.header, question: q.question?.substring(0, 50) }))
    }, '[Server] AskUserQuestion detected');

    // Emit to attempt room (existing behavior)
    io.to(`attempt:${attemptId}`).emit('question:ask', {
      attemptId,
      toolUseId,
      questions,
    });

    // Emit global question:new event for the questions panel
    // Also save to persistent storage (survives CLI auto-handle + attempt completion)
    try {
      const attempt = await db.query.attempts.findFirst({
        where: eq(schema.attempts.id, attemptId),
      });
      if (attempt) {
        // Skip persistent question if autopilot already answered it
        const alreadyAnswered = !agentManager.hasPendingQuestion(attemptId);
        if (alreadyAnswered) {
          log.info({ attemptId }, '[Server] Question already handled (autopilot), skipping persistent storage');
        } else {
          // Save to persistent question storage (keyed by taskId, survives agent cleanup)
          agentManager.setPersistentQuestion(attempt.taskId, {
            attemptId,
            toolUseId,
            questions,
            timestamp: Date.now(),
          });

          const task = await db.query.tasks.findFirst({
            where: eq(schema.tasks.id, attempt.taskId),
          });
          io.emit('question:new', {
            attemptId,
            taskId: attempt.taskId,
            taskTitle: task?.title || '',
            projectId: task?.projectId || '',
            toolUseId,
            questions,
            timestamp: Date.now(),
          });
        }
      }
    } catch (err) {
      log.error({ err }, '[Server] Failed to emit global question:new');
    }

    log.info(`[Server] Emitted question:ask to attempt:${attemptId}`);
  });

  // Handle question resolved from AgentManager (answered or cancelled, including via REST API)
  agentManager.on('questionResolved', ({ attemptId }) => {
    io.emit('question:resolved', { attemptId });
  });

  // Handle background shell detection from AgentManager (Bash with run_in_background=true)
  // NOTE: SDK spawns process but it dies when conversation ends.
  // We spawn our own detached shell that survives.
  // The command should kill existing processes first to avoid port conflicts.
  agentManager.on('backgroundShell', async ({ attemptId, shell }) => {
    log.info(`[Server] Background shell detected for ${attemptId}: ${shell.command}`);

    try {
      const attempt = await db.query.attempts.findFirst({
        where: eq(schema.attempts.id, attemptId),
      });
      if (!attempt) return;

      const task = await db.query.tasks.findFirst({
        where: eq(schema.tasks.id, attempt.taskId),
      });
      if (!task) return;

      const project = await db.query.projects.findFirst({
        where: eq(schema.projects.id, task.projectId),
      });
      if (!project) return;

      // Extract port and find existing process PID
      // Add delay to let nohup process bind to port before checking
      const portMatch = shell.originalCommand?.match(/lsof\s+-ti\s+:(\d+)/);
      if (portMatch) {
        const port = portMatch[1];
        log.info(`[Server] Waiting 6.6s for process to bind to port ${port}...`);
        await new Promise(resolve => setTimeout(resolve, 6666));
        try {
          const { execFileSync } = require('child_process');
          // Validate port is a valid number
          const portNum = parseInt(port, 10);
          if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
            log.warn({ port }, '[Server] Invalid port number, skipping lsof');
            return;
          }
          let pidOutput = '';
          try {
            pidOutput = execFileSync('lsof', ['-ti', `:${portNum}`], { encoding: 'utf-8' }).trim();
          } catch {
            // lsof returns non-zero when no process found
            pidOutput = '';
          }
          if (pidOutput) {
            const pid = parseInt(pidOutput.split('\n')[0], 10);
            if (pid) {
              // Track existing process instead of respawning
              log.info(`[Server] Found existing process on port ${port}: PID ${pid}`);
              const shellId = shellManager.trackExternalProcess({
                projectId: project.id,
                attemptId,
                pid,
                command: shell.command,
                cwd: project.path,
              });

              if (shellId) {
                await db.insert(schema.shells).values({
                  id: shellId,
                  projectId: project.id,
                  attemptId,
                  command: shell.command,
                  cwd: project.path,
                  pid,
                  status: 'running',
                });
                log.info(`[Server] Tracking external process ${shellId} (PID ${pid})`);
                return;
              }
            }
          }
        } catch {
          // Fall through to spawn new shell
        }
      }

      // No existing process found, spawn new shell
      const shellId = shellManager.spawn({
        projectId: project.id,
        attemptId,
        command: shell.command,
        cwd: project.path,
        description: shell.description,
      });

      await db.insert(schema.shells).values({
        id: shellId,
        projectId: project.id,
        attemptId,
        command: shell.command,
        cwd: project.path,
        pid: shellManager.getShell(shellId)?.pid,
        status: 'running',
      });

      log.info(`[Server] Spawned background shell ${shellId} for project ${project.id}`);
    } catch (error) {
      log.error({ error }, '[Server] Failed to spawn background shell');
    }
  });

  // Handle tracked process from BGPID pattern in bash output
  // Track existing process instead of kill-and-respawn to avoid port conflicts
  agentManager.on('trackedProcess', async ({ attemptId, pid, command, logFile: eventLogFile }) => {
    log.info(`[Server] Tracked process detected for ${attemptId}: PID ${pid}`);

    try {
      const attempt = await db.query.attempts.findFirst({
        where: eq(schema.attempts.id, attemptId),
      });

      if (!attempt) {
        log.error('[Server] Cannot track process: attempt not found');
        return;
      }

      const task = await db.query.tasks.findFirst({
        where: eq(schema.tasks.id, attempt.taskId),
      });

      if (!task) {
        log.error('[Server] Cannot track process: task not found');
        return;
      }

      const project = await db.query.projects.findFirst({
        where: eq(schema.projects.id, task.projectId),
      });

      if (!project) {
        log.error('[Server] Cannot track process: project not found');
        return;
      }

      // Extract actual command from nohup wrapper, use eventLogFile if provided
      let actualCommand = command;
      let logFile = eventLogFile;
      const nohupMatch = command.match(/nohup\s+(.+?)\s*>\s*(\/tmp\/[^\s]+\.log)/);
      if (nohupMatch) {
        actualCommand = nohupMatch[1].trim();
        logFile = logFile || nohupMatch[2];
      }
      log.info(`[Server] Extracted command: ${actualCommand}, logFile: ${logFile}`);

      // Track existing process via ShellManager (no kill-and-respawn)
      const shellId = shellManager.trackExternalProcess({
        projectId: project.id,
        attemptId,
        pid,
        command: actualCommand,
        cwd: project.path,
        logFile,
      });

      if (!shellId) {
        log.error({ pid }, '[Server] Failed to track process: PID not alive');
        return;
      }

      // Save to database for persistence
      await db.insert(schema.shells).values({
        id: shellId,
        projectId: project.id,
        attemptId,
        command: actualCommand,
        cwd: project.path,
        pid,
        status: 'running',
      });

      log.info(`[Server] Tracking external process ${shellId} (PID ${pid}) for project ${project.id}`);
    } catch (error) {
      log.error({ error }, '[Server] Failed to track process');
    }
  });

  // Handle "prompt too long" error - trigger auto-compact if enabled
  agentManager.on('promptTooLong', async ({ attemptId }) => {
    log.warn({ attemptId }, '[Server] Prompt too long detected');

    try {
      const autoCompactSetting = await db
        .select()
        .from(schema.appSettings)
        .where(eq(schema.appSettings.key, 'auto_compact_enabled'))
        .limit(1);

      const autoCompactEnabled = autoCompactSetting.length > 0 && autoCompactSetting[0].value === 'true';

      io.to(`attempt:${attemptId}`).emit('context:prompt-too-long', {
        attemptId,
        autoCompactEnabled,
        message: autoCompactEnabled
          ? 'Context limit exceeded. Auto-compacting...'
          : 'Context limit exceeded. Use /compact to reduce context size, or start a new conversation.',
      });
    } catch (error) {
      log.error({ error }, '[Server] Failed to handle prompt-too-long');
    }
  });

  // Register exit event handler
  agentManager.on('exit', async ({ attemptId, code }) => {
    try {
    // Get attempt to retrieve taskId and current status
    const attempt = await db.query.attempts.findFirst({
      where: eq(schema.attempts.id, attemptId),
    });

    if (!attempt) {
      log.error(`[Server] Attempt ${attemptId} not found`);
      return;
    }

    // Preserve 'cancelled' status - don't overwrite if user cancelled
    // The cancel handler already set the correct status
    const status: AttemptStatus = attempt.status === 'cancelled'
      ? 'cancelled'
      : (code === 0 ? 'completed' : 'failed');

    // Get usage stats from tracker
    const usageStats = usageTracker.getUsage(attemptId);
    const gitStatsData = gitStatsCache.get(attemptId);

    // Update attempt with status and usage stats
    // IMPORTANT: Clear session_id on failure to prevent next attempt from resuming
    // a corrupted/empty session. Failed sessions may have incomplete data that causes
    // Claude Code to exit with code 1 when resuming.
    await db
      .update(schema.attempts)
      .set({
        status,
        completedAt: Date.now(),
        // Clear session_id on failure - prevents resume from corrupted sessions
        ...(status === 'failed' && { sessionId: null }),
        // Save usage stats
        ...(usageStats && {
          totalTokens: usageStats.totalTokens,
          inputTokens: usageStats.totalInputTokens,
          outputTokens: usageStats.totalOutputTokens,
          cacheCreationTokens: usageStats.totalCacheCreationTokens,
          cacheReadTokens: usageStats.totalCacheReadTokens,
          totalCostUSD: usageStats.totalCostUSD.toString(),
          numTurns: usageStats.numTurns,
          durationMs: usageStats.durationMs,
          // Context usage (calculated from cache_read_input_tokens)
          contextUsed: usageStats.contextUsed,
          contextLimit: usageStats.contextLimit,
          contextPercentage: Math.round(usageStats.contextPercentage),
          baselineContext: usageStats.baselineContext,
        }),
        // Save git stats
        ...(gitStatsData && {
          diffAdditions: gitStatsData.additions,
          diffDeletions: gitStatsData.deletions,
        }),
      })
      .where(eq(schema.attempts.id, attemptId));

    // Create checkpoint on successful completion
    if (code === 0 && attempt) {
      try {
        // Clear rewind state if this was a rewound attempt
        // This prevents re-rewinding on subsequent attempts
        if (await sessionManager.hasPendingRewind(attempt.taskId)) {
          await sessionManager.clearRewindState(attempt.taskId);
          log.info(`[Server] Cleared rewind state for task ${attempt.taskId}`);
        }

        const sessionId = await sessionManager.getSessionId(attemptId);

        if (sessionId) {
          // Count messages in this attempt
          const logs = await db.query.attemptLogs.findMany({
            where: eq(schema.attemptLogs.attemptId, attemptId),
          });

          // Extract summary from last assistant message
          const summary = extractSummary(logs);

          // Save checkpoint using CheckpointManager
          await checkpointManager.saveCheckpoint(
            attemptId,
            attempt.taskId,
            sessionId,
            logs.filter((l) => l.type === 'json').length,
            summary
          );
        }
      } catch (error) {
        log.error({ attemptId, error }, '[Server] Failed to create checkpoint');
      }
    } else if (attempt) {
      // Clear checkpoint tracking on failure
      checkpointManager.clearAttemptCheckpoint(attemptId);

      // Log session clearing for debugging
      log.info(`[Server] Attempt ${attemptId} failed - session_id cleared to prevent resume from corrupted session`);

      // Clear rewind state on failure too - stale sessions cause API errors
      // This allows next attempt to start fresh instead of repeating failure
      if (await sessionManager.hasPendingRewind(attempt.taskId)) {
        await sessionManager.clearRewindState(attempt.taskId);
        log.info(`[Server] Cleared stale rewind state for task ${attempt.taskId} after failure`);
      }
    }

    log.info(`[Server] Emitting attempt:finished for ${attemptId} with status ${status}`);
    io.to(`attempt:${attemptId}`).emit('attempt:finished', {
      attemptId,
      status,
      code,
    });

    // Emit git stats if available
    const gitStats = gitStatsCache.get(attemptId);
    if (gitStats) {
      log.info(`[Server] Emitting status:git for ${attemptId}: +${gitStats.additions} -${gitStats.deletions}`);
      io.to(`attempt:${attemptId}`).emit('status:git', {
        attemptId,
        stats: gitStats,
      });
    }

    // Skip autopilot/task:finished processing for internal compact attempts
    if (autopilotManager.isInternalCompact(attemptId)) {
      log.info({ attemptId }, '[Server] Internal compact attempt finished, skipping autopilot processing');
    } else {
      // Global event for all clients to track completed tasks
      if (attempt?.taskId) {
        io.emit('task:finished', { taskId: attempt.taskId, status });
      }

      const shouldCompact = !!(status === 'completed' && usageStats?.contextHealth?.shouldCompact);

      // Autopilot: handle task completion for auto-processing
      // Pass shouldCompact so autopilot can compact before moving to in_review
      if (attempt?.taskId && status !== 'cancelled') {
        const autopilotHandled = autopilotManager.isEnabled(
          (await db.query.tasks.findFirst({ where: eq(schema.tasks.id, attempt.taskId) }))?.projectId || ''
        );

        await autopilotManager.onTaskFinished(attempt.taskId, status, {
          db, io, schema, agentManager, sessionManager,
        }, attempt.id, shouldCompact);

        // If autopilot is active, it handles compact internally (before in_review).
        // Only run standalone auto-compact for non-autopilot tasks.
        if (!autopilotHandled && shouldCompact && attempt?.taskId) {
          try {
            const autoCompactSetting = await db
              .select()
              .from(schema.appSettings)
              .where(eq(schema.appSettings.key, 'auto_compact_enabled'))
              .limit(1);

            const autoCompactEnabled = autoCompactSetting.length > 0 && autoCompactSetting[0].value === 'true';

            if (autoCompactEnabled) {
              const compactTask = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, attempt.taskId) });
              const project = compactTask ? await db.query.projects.findFirst({
                where: eq(schema.projects.id, compactTask.projectId),
              }) : null;

              if (project && compactTask) {
                const conversationSummary = await sessionManager.getConversationSummary(attempt.taskId);
                const taskModel = compactTask.lastModel || process.env.ANTHROPIC_MODEL || undefined;
                const taskProvider = compactTask.lastProvider
                  || (taskModel && !/^claude/i.test(taskModel) && !/^(opus|sonnet|haiku)$/i.test(taskModel) ? 'claude-sdk' : undefined);

                const compactAttemptId = nanoid();
                await db.insert(schema.attempts).values({
                  id: compactAttemptId,
                  taskId: attempt.taskId,
                  prompt: 'Auto-compact: summarize conversation context',
                  displayPrompt: 'Auto-compacting conversation...',
                  status: 'running',
                });

                log.info({ attemptId: compactAttemptId, taskId: attempt.taskId, model: taskModel, provider: taskProvider }, '[Server] Auto-compacting conversation');
                io.to(`attempt:${attemptId}`).emit('context:compacting', { attemptId: compactAttemptId, taskId: attempt.taskId });

                agentManager.compact({
                  attemptId: compactAttemptId,
                  projectPath: project.path,
                  conversationSummary,
                  model: taskModel,
                  provider: taskProvider as 'claude-cli' | 'claude-sdk' | undefined,
                });
              }
            }
          } catch (compactError) {
            log.error({ compactError }, '[Server] Auto-compact failed');
          }
        }
      }
    }

    // Mark any remaining in-progress subagents as orphaned in DB
    const orphanedNodes = workflowTracker.markOrphaned(attemptId);
    if (orphanedNodes.length > 0) {
      log.info({ attemptId, count: orphanedNodes.length }, '[Server] Marking orphaned subagents');
      for (const node of orphanedNodes) {
        try {
          await db.update(schema.subagents)
            .set({
              status: 'orphaned',
              completedAt: node.completedAt || Date.now(),
              durationMs: node.durationMs || null,
            })
            .where(eq(schema.subagents.id, node.id));
        } catch (err) {
          log.error({ err, nodeId: node.id }, '[Server] Failed to mark subagent as orphaned');
        }
      }
    }

    // Clean up in-memory tracking data for this attempt to prevent unbounded growth
    usageTracker.clearSession(attemptId);
    workflowTracker.clearWorkflow(attemptId);
    gitStatsCache.clear(attemptId);
    } catch (error) {
      if (isSqliteForeignKeyError(error)) {
        log.warn({ attemptId }, '[Server] Ignoring FK error in exit handler (attempt/task deleted)');
      } else {
        log.error({ attemptId, error }, '[Server] Exit handler failed');
      }
    }
  });

  // Forward tracking module events to Socket.io clients
  // Usage tracking (tokens, costs, model usage)
  usageTracker.on('usage-update', ({ attemptId, usage }) => {
    log.info({ attemptId, totalTokens: usage.totalTokens }, '[Server] Emitting status:usage');
    io.to(`attempt:${attemptId}`).emit('status:usage', {
      attemptId,
      usage,
    });
  });

  // Workflow tracking (subagent execution chain)
  workflowTracker.on('workflow-update', ({ attemptId }) => {
    const expanded = workflowTracker.getExpandedWorkflow(attemptId);
    if (expanded) {
      log.info({ attemptId, chain: expanded.summary.chain }, '[Server] Emitting status:workflow');
      io.to(`attempt:${attemptId}`).emit('status:workflow', {
        attemptId,
        nodes: expanded.nodes,
        messages: expanded.messages,
        tasks: expanded.tasks,
        mode: expanded.mode,
        summary: expanded.summary,
      });

      // Also emit global workflow:update for cross-task awareness
      // Look up taskId and title for the attempt
      db.query.attempts.findFirst({
        where: eq(schema.attempts.id, attemptId),
      }).then(attempt => {
        if (attempt) {
          db.query.tasks.findFirst({
            where: eq(schema.tasks.id, attempt.taskId),
          }).then(task => {
            io.emit('workflow:update', {
              attemptId,
              taskId: attempt.taskId,
              taskTitle: task?.title || 'Unknown',
              summary: expanded.summary,
            });
          }).catch(() => { });
        }
      }).catch(() => { });
    }
  });

  // Persist subagent start to DB
  workflowTracker.on('subagent-start', async ({ attemptId, node }) => {
    try {
      await db.insert(schema.subagents).values({
        id: node.id,
        attemptId,
        type: node.type,
        name: node.name || null,
        parentId: node.parentId,
        teamName: node.teamName || null,
        status: 'in_progress',
        depth: node.depth,
        prompt: node.prompt || null,
        startedAt: node.startedAt || Date.now(),
      });
    } catch (err) {
      log.error({ err, attemptId, nodeId: node.id }, '[Server] Failed to persist subagent start');
    }
  });

  // Persist subagent end to DB
  workflowTracker.on('subagent-end', async ({ attemptId, node }) => {
    try {
      const dbStatus = node.status as 'in_progress' | 'completed' | 'failed' | 'orphaned';
      await db.update(schema.subagents)
        .set({
          status: dbStatus,
          completedAt: node.completedAt || Date.now(),
          durationMs: node.durationMs || null,
          error: node.error || null,
          resultPreview: node.resultPreview || null,
          resultFull: node.resultFull || null,
        })
        .where(eq(schema.subagents.id, node.id));
    } catch (err) {
      log.error({ err, attemptId, nodeId: node.id }, '[Server] Failed to persist subagent end');
    }
  });

  // Persist tracked task events to DB
  workflowTracker.on('workflow-update', async ({ attemptId, workflow }) => {
    if (!workflow?.tasks?.length) return;
    try {
      for (const task of workflow.tasks) {
        await db.insert(schema.trackedTasks)
          .values({
            id: task.id,
            attemptId,
            subject: task.subject,
            description: task.description || null,
            status: task.status,
            owner: task.owner || null,
            activeForm: task.activeForm || null,
            updatedAt: task.updatedAt,
          })
          .onConflictDoUpdate({
            target: schema.trackedTasks.id,
            set: {
              status: task.status,
              owner: task.owner || null,
              activeForm: task.activeForm || null,
              updatedAt: task.updatedAt,
            },
          });
      }
    } catch (err) {
      log.error({ err, attemptId }, '[Server] Failed to persist tracked tasks');
    }
  });

  // Persist inter-agent messages to DB
  // Scoped per-attempt to avoid unbounded memory growth on long-running servers
  const persistedMessageKeys = new Map<string, Set<string>>();
  workflowTracker.on('workflow-update', async ({ attemptId, workflow }) => {
    if (!workflow?.messages?.length) return;
    if (!persistedMessageKeys.has(attemptId)) {
      persistedMessageKeys.set(attemptId, new Set());
    }
    const seen = persistedMessageKeys.get(attemptId)!;
    try {
      for (const msg of workflow.messages) {
        // Deduplicate by sender+recipient+timestamp to handle same-ms messages
        const key = `${msg.fromAgent || msg.fromType}:${msg.toType}:${msg.timestamp}`;
        if (seen.has(key)) continue;
        seen.add(key);
        await db.insert(schema.agentMessages).values({
          attemptId,
          fromAgent: msg.fromAgent || null,
          fromType: msg.fromType,
          toType: msg.toType,
          content: msg.content,
          summary: msg.summary || null,
          isBroadcast: msg.isBroadcast || false,
          timestamp: msg.timestamp,
        });
      }
    } catch (err) {
      log.error({ err, attemptId }, '[Server] Failed to persist agent messages');
    }
  });

  // Clean up per-attempt dedup sets when workflow is cleared
  workflowTracker.on('workflow-cleared', ({ attemptId }: { attemptId: string }) => {
    persistedMessageKeys.delete(attemptId);
  });

  // --- Autopilot context file: record sub-agent & sub-task journey ---
  // Helper to resolve projectPath for an autopilot-managed attempt
  async function resolveAutopilotContext(attemptId: string): Promise<{ taskId: string; projectPath: string } | null> {
    const taskId = autopilotManager.getTaskIdForAttempt(attemptId);
    if (!taskId) return null;
    const attempt = await db.query.attempts.findFirst({ where: eq(schema.attempts.id, attemptId) });
    if (!attempt) return null;
    const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, attempt.taskId) });
    if (!task) return null;
    const project = await db.query.projects.findFirst({ where: eq(schema.projects.id, task.projectId) });
    if (!project?.path) return null;
    return { taskId: attempt.taskId, projectPath: project.path };
  }

  workflowTracker.on('subagent-end', async ({ attemptId, node }) => {
    const ctx = await resolveAutopilotContext(attemptId);
    if (ctx) appendSubagentEnded(ctx.projectPath, ctx.taskId, node.name || null, node.status);
  });

  // Deduplicate tracked task writes per attempt to avoid spamming context file
  const lastTrackedTaskSnapshot = new Map<string, string>();
  workflowTracker.on('workflow-update', async ({ attemptId, workflow }) => {
    if (!workflow?.tasks?.length) return;
    const ctx = await resolveAutopilotContext(attemptId);
    if (!ctx) return;
    // Only write when task statuses actually change
    const snapshot = workflow.tasks.map((t: any) => `${t.subject}:${t.status}`).join('|');
    if (lastTrackedTaskSnapshot.get(attemptId) === snapshot) return;
    lastTrackedTaskSnapshot.set(attemptId, snapshot);
    appendTrackedTaskUpdate(ctx.projectPath, ctx.taskId, workflow.tasks);
  });

  workflowTracker.on('workflow-cleared', ({ attemptId }: { attemptId: string }) => {
    lastTrackedTaskSnapshot.delete(attemptId);
  });


  // Extract summary from last assistant message
  function extractSummary(logs: { type: string; content: string }[]): string {
    for (let i = logs.length - 1; i >= 0; i--) {
      if (logs[i].type === 'json') {
        try {
          const data = JSON.parse(logs[i].content);
          if (data.type === 'assistant' && data.message?.content) {
            const text = data.message.content
              .filter((b: { type: string }) => b.type === 'text')
              .map((b: { text: string }) => b.text)
              .join(' ');
            return text.substring(0, 100) + (text.length > 100 ? '...' : '');
          }
        } catch {
          // Ignore parse errors
        }
      }
    }
    return '';
  }

  // ========================================
  // Tunnel Service Event Handlers
  // ========================================

  // Forward tunnel status changes to all clients
  tunnelService.on('status', (state) => {
    io.emit('tunnel:status', state);
  });

  tunnelService.on('connected', ({ url }) => {
    log.info(`[Server] Tunnel connected: ${url}`);
    io.emit('tunnel:connected', { url });
  });

  tunnelService.on('error', ({ error }) => {
    log.error({ error }, '[Server] Tunnel error');
    io.emit('tunnel:error', { error });
  });

  tunnelService.on('closed', () => {
    log.info('[Server] Tunnel closed');
    io.emit('tunnel:closed');
  });

  httpServer.listen(port, () => {
    log.info(`> Ready on http://${hostname}:${port}`);

    // Start MinIO sync queue workers with server lifecycle
    minioPullQueueWorker.start();
    minioPushQueueWorker.start();
    if (!process.env.NEXT_PUBLIC_URL) {
      log.warn('[Server] NEXT_PUBLIC_URL is not set. Access is limited to localhost only. Set NEXT_PUBLIC_URL in .env to enable remote access.');
    }

    // Try to auto-reconnect tunnel after server is ready
    tunnelService.tryAutoReconnect().catch((err) => {
      log.error({ err }, '[Server] Failed to auto-reconnect tunnel');
    });

    // Log cache stats every 5 minutes for monitoring
    setInterval(() => {
      logCacheStats();
    }, 5 * 60 * 1000).unref();
  });

  // Graceful shutdown handler
  const shutdown = async (signal: string) => {
    log.info(`\n> ${signal} received, shutting down gracefully...`);

    // Stop tunnel
    await tunnelService.stop();
    log.info('> Tunnel stopped');

    // Stop MinIO sync queue workers
    minioPullQueueWorker.stop();
    log.info('> MinIO pull queue worker stopped');

    minioPushQueueWorker.stop();
    log.info('> MinIO push queue worker stopped');

    // Cancel all Claude agents first
    agentManager.cancelAll();
    log.info('> Cancelled all Claude agents');

    // Destroy all interactive terminal sessions
    terminalManager.destroyAll();
    log.info('> Destroyed all terminal sessions');

    // Close all socket connections
    io.close(() => {
      log.info('> Socket.io closed');
    });

    // Close HTTP server
    httpServer.close(() => {
      log.info('> HTTP server closed');
      process.exit(0);
    });

    // Force exit after 5 seconds if graceful shutdown fails
    setTimeout(() => {
      log.error('> Forced exit after timeout');
      process.exit(1);
    }, 5000);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
});
