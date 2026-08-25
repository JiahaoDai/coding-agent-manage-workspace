export type PaneId = 'left' | 'right';

export interface WorkspacePanel {
  paneId: PaneId;
  sessionId: string;
}

export interface WorkspaceState {
  panels: WorkspacePanel[];
  activePane: PaneId | null;
  splitRatio: number;
}

export const DEFAULT_SPLIT_RATIO = 50;
export const MIN_SPLIT_RATIO = 20;
export const MAX_SPLIT_RATIO = 80;

export const emptyWorkspace: WorkspaceState = {
  panels: [],
  activePane: null,
  splitRatio: DEFAULT_SPLIT_RATIO,
};

const paneOrder: PaneId[] = ['left', 'right'];

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SPLIT_RATIO;
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, value));
}

function normalizePanels(panels: WorkspacePanel[], validSessionIds?: Set<string>): WorkspacePanel[] {
  const usedPanes = new Set<PaneId>();
  const usedSessions = new Set<string>();
  const normalized: WorkspacePanel[] = [];

  for (const panel of panels) {
    if (!paneOrder.includes(panel.paneId)) continue;
    if (usedPanes.has(panel.paneId)) continue;
    if (usedSessions.has(panel.sessionId)) continue;
    if (validSessionIds && !validSessionIds.has(panel.sessionId)) continue;
    usedPanes.add(panel.paneId);
    usedSessions.add(panel.sessionId);
    normalized.push(panel);
  }

  return normalized.sort((a, b) => paneOrder.indexOf(a.paneId) - paneOrder.indexOf(b.paneId));
}

function normalizeWorkspace(state: WorkspaceState, validSessionIds?: Set<string>): WorkspaceState {
  const panels = normalizePanels(state.panels, validSessionIds);
  const activePane = panels.some((panel) => panel.paneId === state.activePane)
    ? state.activePane
    : (panels[0]?.paneId ?? null);

  return {
    panels,
    activePane,
    splitRatio: clampRatio(state.splitRatio),
  };
}

function findSessionPane(state: WorkspaceState, sessionId: string): PaneId | null {
  return state.panels.find((panel) => panel.sessionId === sessionId)?.paneId ?? null;
}

function activeOrFirstEmptyPane(state: WorkspaceState): PaneId {
  if (state.activePane) return state.activePane;
  return state.panels.some((panel) => panel.paneId === 'left') ? 'right' : 'left';
}

function otherPane(paneId: PaneId): PaneId {
  return paneId === 'left' ? 'right' : 'left';
}

function upsertPanel(state: WorkspaceState, paneId: PaneId, sessionId: string): WorkspaceState {
  const withoutSession = state.panels.filter((panel) => panel.sessionId !== sessionId);
  const replaced = withoutSession.filter((panel) => panel.paneId !== paneId);
  return normalizeWorkspace({
    ...state,
    panels: [...replaced, { paneId, sessionId }],
    activePane: paneId,
  });
}

export function openInActivePane(state: WorkspaceState, sessionId: string): WorkspaceState {
  const existingPane = findSessionPane(state, sessionId);
  if (existingPane) {
    return { ...state, activePane: existingPane };
  }

  return upsertPanel(state, activeOrFirstEmptyPane(state), sessionId);
}

export function openInSplitPane(state: WorkspaceState, sessionId: string): WorkspaceState {
  const existingPane = findSessionPane(state, sessionId);
  if (existingPane) {
    return { ...state, activePane: existingPane };
  }

  if (state.panels.length === 0) {
    return openInActivePane(state, sessionId);
  }

  const activePane = state.activePane ?? state.panels[0]?.paneId ?? 'left';
  const targetPane = otherPane(activePane);

  return upsertPanel({ ...state, activePane }, targetPane, sessionId);
}

export function closePane(state: WorkspaceState, paneId: PaneId): WorkspaceState {
  const panels = state.panels.filter((panel) => panel.paneId !== paneId);
  return normalizeWorkspace({
    ...state,
    panels,
    activePane: state.activePane === paneId ? (panels[0]?.paneId ?? null) : state.activePane,
  });
}

export function removeSessionFromWorkspace(state: WorkspaceState, sessionId: string): WorkspaceState {
  const panels = state.panels.filter((panel) => panel.sessionId !== sessionId);
  return normalizeWorkspace({
    ...state,
    panels,
    activePane: panels.some((panel) => panel.paneId === state.activePane) ? state.activePane : (panels[0]?.paneId ?? null),
  });
}

export function setActivePane(state: WorkspaceState, paneId: PaneId): WorkspaceState {
  return state.panels.some((panel) => panel.paneId === paneId) ? { ...state, activePane: paneId } : state;
}

export function setSplitRatio(state: WorkspaceState, splitRatio: number): WorkspaceState {
  return { ...state, splitRatio: clampRatio(splitRatio) };
}

export function restoreWorkspace(raw: string | null, validSessionIds: Set<string>): WorkspaceState {
  if (!raw) return emptyWorkspace;
  try {
    const parsed = JSON.parse(raw) as Partial<WorkspaceState>;
    return normalizeWorkspace({
      panels: Array.isArray(parsed.panels) ? parsed.panels as WorkspacePanel[] : [],
      activePane: parsed.activePane === 'left' || parsed.activePane === 'right' ? parsed.activePane : null,
      splitRatio: typeof parsed.splitRatio === 'number' ? parsed.splitRatio : DEFAULT_SPLIT_RATIO,
    }, validSessionIds);
  } catch {
    return emptyWorkspace;
  }
}

export function serializeWorkspace(state: WorkspaceState): string {
  return JSON.stringify(normalizeWorkspace(state));
}
