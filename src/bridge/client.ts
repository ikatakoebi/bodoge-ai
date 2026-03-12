import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type {
  RemoteGameState,
  RemoteCardInstance,
  RemoteArea,
  RemoteStack,
  BridgeClientOptions,
} from './types.js';
import {
  CELL_SIZE,
  CARD_WIDTH,
  CARD_HEIGHT,
  COL_STEP,
  DISCARD_X,
  DISCARD_Y,
} from './types.js';

export class BridgeClient {
  private socket: Socket;
  private state: RemoteGameState | null = null;
  private stateResolvers: Array<(state: RemoteGameState) => void> = [];
  private options: BridgeClientOptions;
  private connected = false;
  private roomId: string | null = null;
  /** When true, ignore incoming sync:fullState / sync:patch (Bridge is source of truth) */
  private suppressIncoming = false;
  /** Callback for raw incoming state even when suppressed (for detecting board actions) */
  private _boardActionCallback: ((state: RemoteGameState) => void) | null = null;

  constructor(options: BridgeClientOptions) {
    this.options = options;

    this.socket = io(options.url, {
      transports: ['polling', 'websocket'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 2000,
      timeout: 10000,
    });

    this._setupListeners();
  }

  private _setupListeners(): void {
    this.socket.on('connect', () => {
      console.log(`[bridge] Connected (id=${this.socket.id})`);
      this.connected = true;
      this._joinOrCreate();
    });

    this.socket.on('disconnect', (reason: string) => {
      console.log(`[bridge] Disconnected: ${reason}`);
      this.connected = false;
    });

    this.socket.on('connect_error', (err: Error) => {
      console.error(`[bridge] Connection error: ${err.message}`);
    });

    this.socket.on('sync:fullState', (incomingState: RemoteGameState) => {
      // ボードアクション検知用コールバック（suppress中でも呼ぶ）
      if (this.suppressIncoming && this._boardActionCallback) {
        this._boardActionCallback(incomingState);
        return;
      }
      if (this.suppressIncoming) return; // 自分のエコーを無視
      this.state = incomingState;
      for (const resolve of this.stateResolvers) {
        resolve(incomingState);
      }
      this.stateResolvers = [];
    });

    // sync:patch を受けた場合もstateを更新
    this.socket.on('sync:patch', (patch: any) => {
      // ボードアクション検知: パッチを一時的に適用して検知コールバックに渡す
      if (this.suppressIncoming && this._boardActionCallback && this.state) {
        try {
          const tempState = JSON.parse(JSON.stringify(this.state));
          for (const op of patch) {
            if (op.op === 'replace' || op.op === 'add') {
              setNestedValue(tempState, op.path, op.value);
            }
          }
          this._boardActionCallback(tempState);
        } catch {
          // パッチ適用失敗時は無視
        }
        return;
      }
      if (this.suppressIncoming) return; // 自分のエコーを無視
      if (this.state) {
        try {
          // fast-json-patch互換の簡易パッチ適用
          for (const op of patch) {
            if (op.op === 'replace' || op.op === 'add') {
              setNestedValue(this.state, op.path, op.value);
            }
          }
        } catch {
          // パッチ失敗時は無視（次のfullStateで回復）
        }
      }
    });

    // ターン確定シグナル（ボード→ブリッジ）
    this.socket.on('play:confirmTurn', () => {
      console.log('[bridge] play:confirmTurn received');
      if (this._confirmTurnCallback) {
        this._confirmTurnCallback();
      }
    });

    // 魔女ゲー: ボードからのアクション選択
    this.socket.on('play:majoAction', (data: { index: number }) => {
      console.log(`[bridge] play:majoAction received: index=${data.index}`);
      if (this._majoActionCallback) {
        this._majoActionCallback(data.index);
      }
    });
  }

  private _confirmTurnCallback: (() => void) | null = null;

  /** ターン確定シグナルのコールバック登録 */
  onConfirmTurn(callback: (() => void) | null): void {
    this._confirmTurnCallback = callback;
  }

  private _joinOrCreate(): void {
    if (this.options.roomId) {
      // 既存ルームに参加
      this.socket.emit('room:join', {
        roomId: this.options.roomId,
        playerName: this.options.playerName || 'Bridge',
        playerColor: '#888888',
      }, (res: any) => {
        if (res?.ok) {
          this.roomId = res.roomId;
          console.log(`[bridge] Joined room: ${res.roomId} as ${res.playerId}`);
        } else {
          console.error(`[bridge] Failed to join room: ${res?.error || 'unknown'}`);
          // ルームが見つからない場合は新規作成
          this._createRoom();
        }
      });
    } else {
      this._createRoom();
    }
  }

  private _createRoom(): void {
    this.socket.emit('room:create', {
      playerName: this.options.playerName || 'Bridge',
      playerColor: '#888888',
    }, (res: any) => {
      if (res?.ok) {
        this.roomId = res.roomId;
        console.log(`[bridge] Created room: ${res.roomId} (playerId=${res.playerId})`);
      } else {
        console.error(`[bridge] Failed to create room: ${res?.error || 'unknown'}`);
      }
    });
  }

  getRoomId(): string | null {
    return this.roomId;
  }

  /** roomIdがセットされるまで待つ（最大5秒） */
  waitForRoomId(): Promise<string> {
    if (this.roomId) return Promise.resolve(this.roomId);
    return new Promise((resolve, reject) => {
      const interval = setInterval(() => {
        if (this.roomId) {
          clearInterval(interval);
          clearTimeout(timeout);
          resolve(this.roomId);
        }
      }, 50);
      const timeout = setTimeout(() => {
        clearInterval(interval);
        reject(new Error('[bridge] roomId not set after 5s'));
      }, 5000);
    });
  }

  /**
   * Bridgeがソースオブトゥルースとして動作中はtrueにする。
   * trueの間、サーバーからのsync:fullState/sync:patchを無視する。
   */
  setSuppressIncoming(suppress: boolean): void {
    this.suppressIncoming = suppress;
  }

  /**
   * ボード操作検知用コールバック。suppress中でもsync:fullStateを受信したら呼ばれる。
   * 人間プレイヤーのボード操作を検知するために使う。
   */
  onBoardAction(callback: ((state: RemoteGameState) => void) | null): void {
    this._boardActionCallback = callback;
  }

  waitForState(): Promise<RemoteGameState> {
    if (this.state !== null) return Promise.resolve(this.state);
    // 状態待ち中は受信を許可する
    const wasSuppressed = this.suppressIncoming;
    this.suppressIncoming = false;
    return new Promise((resolve) => {
      this.stateResolvers.push((state) => {
        this.suppressIncoming = wasSuppressed;
        resolve(state);
      });
    });
  }

  getState(): RemoteGameState {
    if (!this.state) throw new Error('[bridge] State not yet received. Call waitForState() first.');
    return this.state;
  }

  getCardsByDefinition(defId: string): RemoteCardInstance[] {
    const state = this.getState();
    return Object.values(state.cardInstances).filter((c) => c.definitionId === defId);
  }

  getCardsInArea(areaId: string): RemoteCardInstance[] {
    const state = this.getState();
    const area = state.areas.find((a) => a.areaId === areaId);
    if (!area) return [];

    const areaPixelX = area.x * CELL_SIZE;
    const areaPixelY = area.y * CELL_SIZE;
    const areaPixelW = area.width * CELL_SIZE;
    const areaPixelH = area.height * CELL_SIZE;

    return Object.values(state.cardInstances).filter((c) => {
      return (
        c.x >= areaPixelX &&
        c.x < areaPixelX + areaPixelW &&
        c.y >= areaPixelY &&
        c.y < areaPixelY + areaPixelH
      );
    });
  }

  getArea(areaId: string): RemoteArea | undefined {
    const state = this.getState();
    return state.areas.find((a) => a.areaId === areaId);
  }

  /** エリアのプロパティを更新 */
  updateArea(areaId: string, updates: Partial<Pick<RemoteArea, 'x' | 'y' | 'width' | 'height' | 'name'>>): void {
    const state = this.getState();
    const area = state.areas.find((a) => a.areaId === areaId);
    if (!area) return;
    Object.assign(area, updates);
  }

  moveCardToArea(
    instanceId: string,
    areaId: string,
    faceUp = true,
    offsetIndex = 0
  ): void {
    const state = this.getState();
    const area = state.areas.find((a) => a.areaId === areaId);
    if (!area) throw new Error(`[bridge] Area not found: ${areaId}`);

    const areaPixelX = area.x * CELL_SIZE;
    const areaPixelW = area.width * CELL_SIZE;

    // Dynamic spacing: use COL_STEP (100px) but shrink if cards would overflow the area
    const spacing = offsetIndex > 0
      ? Math.min(COL_STEP, Math.floor((areaPixelW - CARD_WIDTH) / offsetIndex))
      : COL_STEP;

    const cardX = areaPixelX + 4 + offsetIndex * spacing;
    const cardY = (area.y + area.height / 2) * CELL_SIZE - CARD_HEIGHT / 2;

    this.moveCardToPosition(instanceId, cardX, cardY, faceUp);
  }

  moveCardToPosition(
    instanceId: string,
    x: number,
    y: number,
    faceUp?: boolean,
    rotation?: number
  ): void {
    const state = this.getState();
    const card = state.cardInstances[instanceId];
    if (!card) throw new Error(`[bridge] Card instance not found: ${instanceId}`);

    // Remove the card from its previous stack (fixes deck counter staying at 15)
    let updatedStacks = state.cardStacks;
    if (card.stackId && state.cardStacks[card.stackId]) {
      const stack = state.cardStacks[card.stackId];
      const newIds = stack.cardInstanceIds.filter((id) => id !== instanceId);
      updatedStacks = {
        ...state.cardStacks,
        [card.stackId]: {
          ...stack,
          cardInstanceIds: newIds,
        } as RemoteStack,
      };
    }

    const updated: RemoteCardInstance = {
      ...card,
      x,
      y,
      stackId: null,
    };

    if (faceUp !== undefined) {
      updated.face = faceUp ? 'up' : 'down';
      updated.visibility = faceUp ? 'public' : 'hidden';
    }

    if (rotation !== undefined) {
      updated.rotation = rotation;
    }

    this.state = {
      ...state,
      cardInstances: {
        ...state.cardInstances,
        [instanceId]: updated,
      },
      cardStacks: updatedStacks,
    };
  }

  /**
   * Find per-player score counters.
   * Returns a Map<slot, counterId> e.g. { "p0" => "counter_xxx", "p1" => "counter_yyy" }
   * Matches counters whose name contains "スコア" or "score" and have a player number prefix (P1, P2, ...).
   */
  findScoreCounters(): Map<string, string> {
    const state = this.getState();
    const result = new Map<string, string>();
    for (const [id, counter] of Object.entries(state.counters)) {
      const nameLower = counter.name.toLowerCase();
      if (nameLower.includes('スコア') || nameLower.includes('score')) {
        // Counter name format: "P1 スコア", "P2 スコア", etc.
        const playerMatch = counter.name.match(/^P(\d+)\s/);
        if (playerMatch) {
          const playerNum = parseInt(playerMatch[1], 10);
          result.set(`p${playerNum - 1}`, id);
        }
      }
    }
    return result;
  }

  repositionCounter(counterId: string, x: number, y: number): void {
    const state = this.getState();
    const counter = state.counters[counterId];
    if (!counter) return;
    this.state = {
      ...state,
      counters: {
        ...state.counters,
        [counterId]: { ...counter, x, y },
      },
    };
  }

  updateCounter(counterId: string, value: number): void {
    const state = this.getState();
    const counter = state.counters[counterId];
    if (!counter) throw new Error(`[bridge] Counter not found: ${counterId}`);

    this.state = {
      ...state,
      counters: {
        ...state.counters,
        [counterId]: {
          ...counter,
          value: Math.max(counter.min, Math.min(counter.max, value)),
        },
      },
    };
  }

  /** ボード上に表示するアナウンスメッセージ */
  private _announcement: string | null = null;
  /** プレイモードで人間が操作するスロット (例: 'p0') */
  private _humanSlot: string | null = null;
  /** 魔女ゲー: ボードに表示するアクション選択肢 */
  private _majoActions: Array<{ index: number; description: string; category: string }> | null = null;
  /** 魔女ゲー: ゲーム状態全体（ボード上のゲーム情報パネル用） */
  private _majoGameInfo: Record<string, unknown> | null = null;
  /** 魔女ゲー: ボードからのアクション選択コールバック */
  private _majoActionCallback: ((index: number) => void) | null = null;

  setAnnouncement(msg: string | null): void {
    this._announcement = msg;
  }

  setHumanSlot(slot: string | null): void {
    this._humanSlot = slot;
  }

  setMajoActions(actions: Array<{ index: number; description: string; category: string }> | null): void {
    this._majoActions = actions;
  }

  setMajoGameInfo(info: Record<string, unknown> | null): void {
    this._majoGameInfo = info;
  }

  /** 魔女ゲー: ボードからのアクション選択イベントのコールバック登録 */
  onMajoAction(callback: ((index: number) => void) | null): void {
    this._majoActionCallback = callback;
  }

  sendState(): void {
    if (!this.state) throw new Error('[bridge] No state to send.');
    const payload: Record<string, unknown> = { ...this.state };
    if (this._announcement) {
      payload.announcement = this._announcement;
    }
    if (this._humanSlot) {
      payload.humanSlot = this._humanSlot;
    }
    if (this._majoActions) {
      payload.majoActions = this._majoActions;
    }
    if (this._majoGameInfo) {
      payload.majoGameInfo = this._majoGameInfo;
    }
    this.socket.emit('sync:fullState', payload);
  }

  discardCard(instanceId: string): void {
    this.moveCardToPosition(instanceId, DISCARD_X, DISCARD_Y, false);
  }

  restoreState(state: RemoteGameState): void {
    this.state = JSON.parse(JSON.stringify(state));
  }

  delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  disconnect(): void {
    this.socket.disconnect();
  }

  isConnected(): boolean {
    return this.connected;
  }
}

/** Set a nested value in an object using a JSON Pointer path (e.g. "/cardInstances/abc/x") */
function setNestedValue(obj: any, path: string, value: any): void {
  const parts = path.split('/').filter(Boolean);
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] === undefined) current[parts[i]] = {};
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
}
