import { describe, expect, it } from 'vitest';
import {
  closePane,
  emptyWorkspace,
  openInActivePane,
  openInSplitPane,
  removeSessionFromWorkspace,
  restoreWorkspace,
  serializeWorkspace,
  setActivePane,
  setSplitRatio,
  type WorkspaceState,
} from './workspace';

describe('workspace panel placement', () => {
  it('opens a session in the active panel', () => {
    const state = openInActivePane(emptyWorkspace, 's1');

    expect(state).toEqual({
      panels: [{ paneId: 'left', sessionId: 's1' }],
      activePane: 'left',
      splitRatio: 50,
    });
  });

  it('opens split sessions into the non-active panel', () => {
    const one = openInActivePane(emptyWorkspace, 's1');
    const two = openInSplitPane(one, 's2');

    expect(two.panels).toEqual([
      { paneId: 'left', sessionId: 's1' },
      { paneId: 'right', sessionId: 's2' },
    ]);
    expect(two.activePane).toBe('right');
  });

  it('treats split open as a normal open when no panel exists yet', () => {
    expect(openInSplitPane(emptyWorkspace, 's1')).toEqual({
      panels: [{ paneId: 'left', sessionId: 's1' }],
      activePane: 'left',
      splitRatio: 50,
    });
  });

  it('replaces the non-active panel when opening in split with two panels', () => {
    const initial: WorkspaceState = {
      panels: [
        { paneId: 'left', sessionId: 's1' },
        { paneId: 'right', sessionId: 's2' },
      ],
      activePane: 'left',
      splitRatio: 62,
    };

    expect(openInSplitPane(initial, 's3')).toEqual({
      panels: [
        { paneId: 'left', sessionId: 's1' },
        { paneId: 'right', sessionId: 's3' },
      ],
      activePane: 'right',
      splitRatio: 62,
    });
  });

  it('activates an already-open session instead of duplicating it', () => {
    const initial: WorkspaceState = {
      panels: [
        { paneId: 'left', sessionId: 's1' },
        { paneId: 'right', sessionId: 's2' },
      ],
      activePane: 'left',
      splitRatio: 50,
    };

    expect(openInSplitPane(initial, 's1')).toEqual({ ...initial, activePane: 'left' });
    expect(openInActivePane({ ...initial, activePane: 'right' }, 's1')).toEqual({ ...initial, activePane: 'left' });
  });
});

describe('workspace close and restore', () => {
  it('closes panels and falls back to the remaining panel or empty state', () => {
    const initial: WorkspaceState = {
      panels: [
        { paneId: 'left', sessionId: 's1' },
        { paneId: 'right', sessionId: 's2' },
      ],
      activePane: 'right',
      splitRatio: 50,
    };

    const one = closePane(initial, 'right');
    expect(one).toEqual({
      panels: [{ paneId: 'left', sessionId: 's1' }],
      activePane: 'left',
      splitRatio: 50,
    });

    expect(closePane(one, 'left')).toEqual(emptyWorkspace);
  });

  it('removes deleted sessions from the workspace', () => {
    const initial: WorkspaceState = {
      panels: [
        { paneId: 'left', sessionId: 's1' },
        { paneId: 'right', sessionId: 's2' },
      ],
      activePane: 'right',
      splitRatio: 50,
    };

    expect(removeSessionFromWorkspace(initial, 's2')).toEqual({
      panels: [{ paneId: 'left', sessionId: 's1' }],
      activePane: 'left',
      splitRatio: 50,
    });
  });

  it('restores only valid sessions and clamps the split ratio', () => {
    const restored = restoreWorkspace(
      JSON.stringify({
        panels: [
          { paneId: 'left', sessionId: 's1' },
          { paneId: 'right', sessionId: 'missing' },
        ],
        activePane: 'right',
        splitRatio: 4,
      }),
      new Set(['s1']),
    );

    expect(restored).toEqual({
      panels: [{ paneId: 'left', sessionId: 's1' }],
      activePane: 'left',
      splitRatio: 20,
    });
  });

  it('serializes normalized workspace state', () => {
    const state = setSplitRatio(setActivePane(openInSplitPane(openInActivePane(emptyWorkspace, 's1'), 's2'), 'left'), 90);

    expect(JSON.parse(serializeWorkspace(state))).toEqual({
      panels: [
        { paneId: 'left', sessionId: 's1' },
        { paneId: 'right', sessionId: 's2' },
      ],
      activePane: 'left',
      splitRatio: 80,
    });
  });
});
