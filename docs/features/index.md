# Feature Documentation Index

This directory contains comprehensive documentation for Claude Workspace's core features. Each feature doc explains architecture, APIs, and typical user workflows.

## Features

### [Kanban Board](./kanban-board.md)

Drag-and-drop task management with five status columns (Todo, In Progress, In Review, Done, Cancelled). Tasks maintain conversation history and link to AI agent executions.

**Key sections:**
- Status columns and data model
- DnD Kit setup (desktop + mobile)
- CRUD operations and persistence
- Context menus and quick actions
- Chat history integration
- Column visibility filtering
- Search and filtering

**Tech stack:** @dnd-kit/core, Zustand, optimistic updates

---

### [Code Editor](./code-editor.md)

Tabbed CodeMirror editor with AI-powered inline editing, syntax highlighting for 14 languages, and file conflict resolution.

**Key sections:**
- CodeMirror 6 configuration and language support
- Inline edit sessions (prompting → generating → preview → applying)
- Diff viewer and merge conflict resolution
- Go-to-definition navigation
- Markdown preview mode
- Editor extensions and custom theming
- Multi-tab management

**Tech stack:** @uiw/react-codemirror, @codemirror/*, Claude API for edits

---

### [Terminal](./terminal.md)

Embedded multi-tab shell with xterm.js frontend and Node-PTY backend. Sessions persist across page refreshes and survive background operation.

**Key sections:**
- xterm.js integration with ANSI color support
- Node-PTY process management and lifecycle
- Multi-tab support with session persistence
- Background PTY reconnection on page reload
- Process crash detection
- Mobile touch gestures and keyboard shortcuts
- Input/output streaming via WebSocket
- Panel resizing and context menus

**Tech stack:** @xterm/xterm, Socket.IO, Node-PTY, Zustand with persistence

---

### [Git Integration](./git-integration.md)

Full Git workflow including staging, commits, push/pull, and visual commit graph. AI-generated commit messages and conflict resolution helpers.

**Key sections:**
- CLI-based git operations (no bindings)
- Status and diff endpoints
- Stage, commit, and remote operations (push/pull/fetch)
- Branch management
- Commit history with visual graph
- Lane calculation and SVG path generation
- File status badges and sections
- AI commit message generation
- Conflict resolution with three-way diff
- Integration in sidebar git panel

**Tech stack:** Node.js child_process (git CLI), SVG rendering, Claude API for messages

---

### [OpenKey Auth](./openkey-auth.md)

OpenKey-based SIWE sign-in for workspace sessions, including nonce handling, key selection, and the difference between SIWE and Claude provider OAuth setup.

**Key sections:**
- OpenKey connection and key selection
- SIWE challenge/message/signature flow
- Nonce handling and replay protection
- OAuth vs SIWE separation
- Example component and API usage

**Tech stack:** OpenKey SDK, SIWE challenge store, Next.js route handlers

## Architecture Patterns

### State Management

All features use **Zustand** for client-side state:
- `useTaskStore` — kanban tasks
- `useTerminalStore` — terminal tabs and panel state (persisted)
- `useInlineEditStore` — inline edit sessions (ephemeral)
- `usePanelLayoutStore` — UI layout (column visibility, etc.)

### API Communication

- **REST endpoints** in `src/app/api/` for standard CRUD
- **WebSocket (Socket.IO)** for real-time streams (terminal, shell)
- **Optimistic updates** on client, rollback on API errors
- **Error toasts** for user feedback

### Performance Techniques

- Memoization (useMemo) to prevent cascade renders
- Debouncing (search, resize handlers)
- Incremental syntax highlighting (CodeMirror)
- Buffered output (terminal: max 60fps)
- Binary WebSocket protocol for efficiency

### Accessibility

- Keyboard shortcuts (Ctrl+S, Ctrl+Z, etc.)
- Screen reader support (aria-live, semantic HTML)
- High contrast themes
- Touch targets >44px minimum
- Focus management and navigation flow

## Feature Integration Points

### Task → Chat Integration

When a task is selected:
1. Task conversations load in chat panel
2. AI agents execute with task description as context
3. Agent results update task status and conversation
4. User can review, edit, or re-run

**Stores involved:** taskStore, floatingWindowsStore, attemptStore

### Git → Editor Integration

When files are modified:
1. Git panel shows status in real-time
2. Editor syncs unsaved state with git status
3. Conflict markers in files trigger resolver modal
4. After resolve, files auto-stage and ready to commit

**Stores involved:** projectStore, fileStore (implicit)

### Terminal → Project Integration

Terminal CWD defaults to active project path:
1. Terminal created with projectId context
2. Shell starts in project root directory
3. Build commands, git operations run in project context
4. Output can link back to editor files (if parsed)

**Stores involved:** projectStore, terminalStore

---

## File Organization

```
docs/features/
├── index.md                    # This file (navigation)
├── kanban-board.md            # Task management
├── code-editor.md             # Code editing and AI inline edits
├── terminal.md                # Embedded shell sessions
├── git-integration.md         # Version control workflow
└── openkey-auth.md            # OpenKey + SIWE authentication
```

---

## Development Workflow Example

**Scenario:** User wants to add a feature and track progress

1. **Create Task** (Kanban)
   - Title: "Add user auth"
   - Description: Details
   - Task starts in **todo**, linked to conversation

2. **Start Work** (Terminal)
   - Open terminal, create feature branch
   - Pull latest main, create auth feature branch

3. **Edit Code** (Editor)
   - Open auth components
   - Use inline edit (Ctrl+Shift+E) to generate auth logic
   - Preview diff, accept changes

4. **Test & Commit** (Terminal + Git)
   - Run tests in terminal
   - Go to Git panel, review staged changes
   - Generate AI commit message: "feat: add user authentication"
   - Push to origin/feature/auth

5. **Track Progress** (Kanban + Chat)
   - Drag task to **in_progress** (auto-starts if pending)
   - Chat shows conversation history
   - AI agent runs validation checks
   - Task moves to **in_review** when agent finishes

6. **Merge & Close** (Git + Kanban)
   - Create pull request (via git push)
   - Handle merge conflicts if needed (resolver modal)
   - Pull merged main branch
   - Move task to **done**

---

## Adding New Features

When documenting a new feature:

1. **Create new file** in `docs/features/` (kebab-case name)
2. **Include sections:**
   - What & Why (1-2 sentence intro)
   - Core architecture (data models, APIs)
   - Key implementation details (store, components, hooks)
   - State management approach
   - User workflows (typical interactions)
   - Performance considerations
   - Related files table

3. **Update this index.md** with new feature entry

4. **Keep file under 800 lines** (split into subtopic files if needed)

---

## Performance Guidelines

| Operation | Target | Actual |
|-----------|--------|--------|
| Task drag-reorder | <100ms | ~50ms |
| Inline edit generation | Real-time stream | <2s typical |
| Terminal output | <50ms latency | WebSocket bound |
| Commit graph (30 commits) | <100ms | ~70ms |
| Search history | 300ms debounce | Varies by DB |

---

## Known Limitations

- **Editor:** Large files (>10MB) not supported
- **Terminal:** Session data not persisted to disk (memory only)
- **Git:** Large repos (100+ commits) pagination recommended
- **Kanban:** No task dependencies or subtasks yet

---

## Future Enhancements

- Task subtasks and checklists
- Terminal recording and replay
- Git worktree support
- Code folding in editor
- Collaborative editing
