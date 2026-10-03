/**
 * test/shell/fakes.ts — the fakes the store tests drive.
 *
 * A fake `IpcInvoker` and a fake `IpcListener`, plus a snapshot builder. Nothing
 * here imports Electron, and nothing imports the store, so a test can build a
 * world and then decide what to do with it.
 *
 * The invoker is deliberately *not* a stub that returns a fixed value. It records
 * every call and delegates to a handler table, so a test can assert the exact
 * channel and payload the UI sent — which is the half of an IPC boundary that
 * actually breaks, and the half a snapshot-shaped fake would never catch.
 */

import type { SceneFile } from '@contextforge/core';
import {
  CHANNELS,
  EVENTS,
  type EditorState,
  type EventPayload,
  type IpcChannel,
  type IpcInvoker,
  type IpcListener,
  type IpcRequest,
  type IpcResponse,
  type PrefabRegistryResult,
  type ProjectInfo,
  type Result,
  type SceneSnapshot,
} from '../../src/ipc.js';

/** One recorded call. */
export interface Call {
  channel: string;
  request: unknown;
}

/** A recording invoker whose answers a test supplies per channel. */
export class FakeInvoker implements IpcInvoker {
  /** Every call, in order. */
  readonly calls: Call[] = [];
  /** How many times each channel was called. */
  readonly counts = new Map<string, number>();

  constructor(
    private readonly answers: Partial<Record<IpcChannel, (request: unknown) => Promise<unknown>>>,
  ) {}

  async invoke<C extends IpcChannel>(
    channel: C,
    request: IpcRequest<C>,
  ): Promise<IpcResponse<C>> {
    this.calls.push({ channel, request });
    this.counts.set(channel, (this.counts.get(channel) ?? 0) + 1);

    const answer = this.answers[channel];
    if (answer === undefined) {
      return fail(`The fake invoker has no answer for "${channel}".`) as IpcResponse<C>;
    }
    return (await answer(request)) as IpcResponse<C>;
  }

  /** The requests sent on one channel, in order. */
  requestsFor(channel: string): unknown[] {
    return this.calls.filter((c) => c.channel === channel).map((c) => c.request);
  }

  /** The last request sent on a channel. */
  lastRequest(channel: string): unknown {
    const all = this.requestsFor(channel);
    return all[all.length - 1];
  }
}

/** A listener a test fires by hand, standing in for `webContents.send`. */
export class FakeListener {
  private readonly handlers = new Map<string, Set<(payload: unknown) => void>>();

  /** The `IpcListener` the store takes. */
  readonly on: IpcListener = <E extends keyof typeof EVENTS>(
    event: E,
    handler: (payload: EventPayload<E>) => void,
  ): (() => void) => {
    const key = event as string;
    const set = this.handlers.get(key) ?? new Set();
    set.add(handler as (payload: unknown) => void);
    this.handlers.set(key, set);
    return () => {
      set.delete(handler as (payload: unknown) => void);
    };
  };

  /** Deliver an event to every subscriber. */
  fire<E extends keyof typeof EVENTS>(event: E, payload: EventPayload<E>): void {
    for (const handler of this.handlers.get(event as string) ?? []) {
      handler(payload);
    }
  }

  /** How many subscribers an event has. */
  subscriberCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}

/** A timer a test drives by hand, so no test waits six real seconds. */
export class FakeClock {
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
  private current = 0;

  readonly now = (): number => this.current;

  readonly setTimer = (fn: () => void, ms: number): unknown => {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.current + ms, fn });
    return id;
  };

  readonly clearTimer = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  /** Advance time, running everything that comes due. */
  advance(ms: number): void {
    this.current += ms;
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.at <= this.current)
      .sort((a, b) => a[1].at - b[1].at);
    for (const [id, timer] of due) {
      this.timers.delete(id);
      timer.fn();
    }
  }

  /** How many timers are pending. */
  get pending(): number {
    return this.timers.size;
  }
}

/** A `Result` that succeeded. */
export function succeed<T>(value: T): Result<T> {
  return { ok: true, value };
}

/** A `Result` that failed. */
export function refuse<T = never>(reason: string): Result<T> {
  return { ok: false, reason };
}

/** A project descriptor for a snapshot. */
export function projectInfo(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    root: '/tmp/demo',
    name: 'demo',
    scenePath: 'scene.json',
    engine: 'three',
    ...overrides,
  };
}

/** A registry with nothing in it. */
export function emptyRegistry(): PrefabRegistryResult {
  return { prefabs: [], failed: [] };
}

/** A snapshot with a scene and no problems. */
export function snapshotOf(
  scene: SceneFile,
  overrides: Partial<SceneSnapshot> = {},
): SceneSnapshot {
  return {
    project: projectInfo(),
    scene,
    prefabs: emptyRegistry(),
    history: { canUndo: false, canRedo: false, undoCount: 0, redoCount: 0 },
    problems: [],
    ...overrides,
  };
}

/** A two-cube scene, enough to make an edit observable. */
export function demoScene(): SceneFile {
  return {
    version: 1,
    name: 'Level1',
    engine: 'three',
    seed: 7,
    instances: [
      {
        id: 'floor',
        prefab: 'cube',
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        params: {},
      },
      {
        id: 'marker',
        prefab: 'cube',
        transform: { position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        params: {},
      },
    ],
    lights: [{ id: 'sun', kind: 'ambient', color: '#ffffff', intensity: 1 }],
    camera: { kind: 'perspective', position: [0, 5, 10], rotation: [0, 0, 0] },
  };
}

/** A copy, so a test can assert the store did not mutate what it was given. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The `EditorState` a store with nothing open holds. */
export function emptyEditorState(): EditorState {
  return {
    snapshot: null,
    selection: { kind: 'none' },
    gizmo: 'translate',
    space: 'world',
    snap: null,
  };
}

/** Channel names, for the tests that assert the registry covers them all. */
export const ALL_CHANNELS: readonly string[] = Object.values(CHANNELS);

/** Event names, likewise. */
export const ALL_EVENTS: readonly string[] = Object.values(EVENTS);
