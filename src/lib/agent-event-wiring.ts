/**
 * Agent Event Wiring - Provider event listener setup and workflow tracking
 *
 * Extracted from agent-manager.ts. Wires provider events (message, question,
 * complete, error, stderr) to AgentManager events. Also tracks subagent
 * workflow and Bash commands from raw SDK/CLI messages.
 */

import type { ClaudeOutput } from '../types';
import type { BackgroundShellInfo, SDKResultMessage } from '@/lib/sdk-event-adapter';
import { sessionManager } from '@/lib/session-manager';
import { checkpointManager } from '@/lib/checkpoint-manager';
import { usageTracker } from '@/lib/usage-tracker';
import { workflowTracker } from '@/lib/workflow-tracker';
import { collectGitStats, gitStatsCache } from '@/lib/git-stats-collector';
import { isServerCommand, readOutputFile } from '@/lib/agent-output-handler';
import type { Provider } from '@/lib/providers';

/** Interface for the AgentManager context needed by event wiring */
export interface EventWiringContext {
  getSessionId(attemptId: string): string | undefined;
  setSessionId(attemptId: string, sessionId: string): void;
  deleteAgent(attemptId: string): void;
  emit(event: string, data: unknown): boolean;
  pendingBashCommands: Map<string, { command: string; attemptId: string }>;
}

/**
 * Wire provider events to AgentManager events for a specific attempt.
 * Returns a cleanup function that removes all listeners.
 */
export function wireProviderEvents(
  ctx: EventWiringContext,
  provider: Provider,
  attemptId: string,
  outputFormat?: string,
  projectPath?: string,
): () => void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listeners: Array<{ event: string; fn: (...args: any[]) => void }> = [];

  const cleanup = () => {
    for (const { event, fn } of listeners) {
      provider.removeListener(event, fn);
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const addListener = (event: string, fn: (...args: any[]) => void) => {
    listeners.push({ event, fn });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    provider.on(event as any, fn);
  };

  addListener('message', async (data: {
    attemptId: string;
    output: ClaudeOutput;
    sessionId?: string;
    checkpointUuid?: string;
    backgroundShell?: BackgroundShellInfo;
    resultMessage?: SDKResultMessage;
    rawMessage?: unknown;
  }) => {
    if (data.attemptId !== attemptId) return;

    if (data.sessionId) {
      ctx.setSessionId(attemptId, data.sessionId);
      await sessionManager.saveSession(attemptId, data.sessionId);
    }

    if (data.checkpointUuid) {
      checkpointManager.captureCheckpointUuid(attemptId, data.checkpointUuid);
    }

    if (data.rawMessage) {
      trackWorkflowFromMessage(ctx, attemptId, data.rawMessage);
    }

    if (data.resultMessage) {
      usageTracker.trackResult(attemptId, data.resultMessage);
    }

    if (data.backgroundShell) {
      ctx.emit('backgroundShell', { attemptId, shell: data.backgroundShell });
    }

    // Emit adapted message (suppress result if custom output format)
    if (!(data.output.type === 'result' && outputFormat)) {
      if (outputFormat) {
        data.output.outputFormat = outputFormat;
      }
      ctx.emit('json', { attemptId, data: data.output });
    }
  });

  addListener('question', (data: { attemptId: string; toolUseId: string; questions: unknown[] }) => {
    if (data.attemptId !== attemptId) return;
    ctx.emit('question', data);
  });

  addListener('questionResolved', (data: { attemptId: string }) => {
    if (data.attemptId !== attemptId) return;
    ctx.emit('questionResolved', data);
  });

  addListener('complete', async (data: { attemptId: string; sessionId?: string }) => {
    if (data.attemptId !== attemptId) return;

    if (outputFormat) {
      readOutputFile(ctx, attemptId, outputFormat);
    }

    if (projectPath) {
      try {
        const gitStats = await collectGitStats(projectPath);
        if (gitStats) gitStatsCache.set(attemptId, gitStats);
      } catch { /* continue */ }
    }

    ctx.deleteAgent(attemptId);
    ctx.emit('exit', { attemptId, code: 0 });
    cleanup();
  });

  addListener('error', (data: { attemptId: string; error: string; errorName: string; isPromptTooLong?: boolean }) => {
    if (data.attemptId !== attemptId) return;

    ctx.emit('stderr', { attemptId, content: `${data.errorName}: ${data.error}` });

    if (data.isPromptTooLong) {
      ctx.emit('promptTooLong', { attemptId });
    }

    ctx.deleteAgent(attemptId);
    ctx.emit('exit', { attemptId, code: 1 });
    cleanup();
  });

  addListener('stderr', (data: { attemptId: string; content: string }) => {
    if (data.attemptId !== attemptId) return;
    ctx.emit('stderr', data);
  });

  return cleanup;
}

/**
 * Track workflow from raw SDK/CLI messages (subagent starts/ends, team creation, Bash commands)
 */
function trackWorkflowFromMessage(ctx: EventWiringContext, attemptId: string, message: unknown): void {
  const msg = message as {
    type: string;
    message?: { content: Array<{ type: string; id?: string; name?: string; input?: unknown }> };
    parent_tool_use_id?: string | null;
  };

  if (msg.type === 'assistant' && msg.message?.content) {
    for (const block of msg.message.content) {
      if (block.type === 'tool_use' && (block.name === 'Task' || block.name === 'Agent') && block.id) {
        const taskInput = (block as { input?: { subagent_type?: string; team_name?: string; name?: string; prompt?: string; description?: string } }).input;
        workflowTracker.trackSubagentStart(
          attemptId, block.id, taskInput?.subagent_type || 'unknown',
          msg.parent_tool_use_id || null,
          { teamName: taskInput?.team_name, name: taskInput?.name, prompt: taskInput?.prompt || taskInput?.description },
        );
      }
      if (block.type === 'tool_use' && block.name === 'TeamCreate' && block.id) {
        const teamInput = (block as { input?: { team_name?: string } }).input;
        if (teamInput?.team_name) workflowTracker.trackTeamCreate(attemptId, teamInput.team_name);
      }
      if (block.type === 'tool_use' && block.name === 'SendMessage' && block.id) {
        const msgInput = (block as { input?: { type?: string; to?: string; recipient?: string; content?: string; message?: string | object; summary?: string } }).input;
        if (msgInput) {
          // Best-effort sender inference: find most recent active agent
          const workflow = workflowTracker.getWorkflow(attemptId);
          let inferredSender: string | undefined;
          if (workflow) {
            const activeNodes = workflow.activeNodes
              .map(id => workflow.nodes.get(id))
              .filter(Boolean)
              .sort((a, b) => (b!.startedAt || 0) - (a!.startedAt || 0));
            inferredSender = activeNodes[0]?.name || activeNodes[0]?.type;
          }
          const messageContent = typeof msgInput.message === 'string' ? msgInput.message : (msgInput.content || '');
          workflowTracker.trackMessage(attemptId, {
            ...msgInput,
            content: messageContent,
            fromAgent: inferredSender,
            isBroadcast: msgInput.to === '*',
          });
        }
      }
      if (block.type === 'tool_use' && block.name === 'TaskCreate' && block.id) {
        const tcInput = (block as { input?: { subject?: string; description?: string; activeForm?: string } }).input;
        if (tcInput) workflowTracker.trackTaskCreate(attemptId, block.id, tcInput);
      }
      if (block.type === 'tool_use' && block.name === 'TaskUpdate' && block.id) {
        const tuInput = (block as { input?: { taskId?: string; status?: string; owner?: string; subject?: string; activeForm?: string } }).input;
        if (tuInput) workflowTracker.trackTaskUpdate(attemptId, tuInput);
      }
      // Track Bash tool_uses for BGPID correlation
      if (block.type === 'tool_use' && block.name === 'Bash' && block.id) {
        const bashInput = block.input as { command?: string } | undefined;
        const toolId = block.id;
        if (bashInput?.command) {
          ctx.pendingBashCommands.set(toolId, { command: bashInput.command, attemptId });
          setTimeout(() => ctx.pendingBashCommands.delete(toolId), 5 * 60 * 1000);
        }
      }
    }
  }

  if (msg.type === 'user' && msg.message?.content) {
    const userContent = msg.message.content as Array<{ type: string; tool_use_id?: string; is_error?: boolean; content?: string | unknown[] }>;
    for (const block of userContent) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        // Extract result content for Task tool results
        let resultContent = '';
        if (typeof block.content === 'string') {
          resultContent = block.content;
        } else if (Array.isArray(block.content)) {
          resultContent = (block.content as Array<{ text?: string }>)
            .filter(c => c && typeof c === 'object' && 'text' in c)
            .map(c => c.text || '').join('');
        }

        workflowTracker.trackSubagentEnd(attemptId, block.tool_use_id, !block.is_error, block.is_error ? resultContent : undefined, resultContent);

        // Detect BGPID pattern
        let content = '';
        if (typeof block.content === 'string') {
          content = block.content;
        } else if (Array.isArray(block.content)) {
          content = (block.content as Array<{ text?: string }>)
            .filter(c => c && typeof c === 'object' && 'text' in c)
            .map(c => c.text || '').join('');
        }

        const bgpidMatch = content.match(/BGPID:(\d+)/);
        const emptyBgpidMatch = content.match(/BGPID:\s*$/m) || content.trim() === 'BGPID:';

        if (bgpidMatch && block.tool_use_id) {
          const pid = parseInt(bgpidMatch[1], 10);
          const bashInfo = ctx.pendingBashCommands.get(block.tool_use_id);
          const command = bashInfo?.command || `Background process (PID: ${pid})`;
          const logMatch = command.match(/>\s*([^\s]+\.log)/);
          ctx.emit('trackedProcess', { attemptId, pid, command, logFile: logMatch?.[1] });
          ctx.pendingBashCommands.delete(block.tool_use_id);
        } else if (emptyBgpidMatch && block.tool_use_id) {
          const bashInfo = ctx.pendingBashCommands.get(block.tool_use_id);
          if (bashInfo?.command && isServerCommand(bashInfo.command)) {
            const nohupMatch = bashInfo.command.match(/nohup\s+(.+?)\s*>\s*\/tmp\//);
            if (nohupMatch) {
              ctx.emit('backgroundShell', {
                attemptId,
                shell: { toolUseId: block.tool_use_id, command: nohupMatch[1].trim(), description: 'Auto-spawned from empty BGPID', originalCommand: bashInfo.command },
              });
            }
          }
          ctx.pendingBashCommands.delete(block.tool_use_id);
        }
      }
    }
  }
}
