/**
 * MajoBoardSync — 魔女ゲーのボード同期
 * MajoPlayController のゲーム状態を BridgeClient 経由でボードに反映する
 */

import type { BridgeClient } from './client.js';
import type { MajoGameInfo, MajoPlayController } from './majo-play.js';

// 魔女ゲーはstandardテンプレート(126×176px)を使用
// types.tsのCARD_WIDTH/CARD_HEIGHTはmini(88×126)なので使わない
// colStep = Math.ceil((126 + 8) / 10) * 10 = 140px
const MAJO_CARD_WIDTH = 126;
const MAJO_CARD_HEIGHT = 176;
const MAJO_COL_STEP = 140; // Math.ceil((126+8)/10)*10

/** 魔女ゲースプレッドシートID */
export const MAJO_SHEET_ID = '1h7iwwlbE6_QBd3ClFFAW-PrgVx0quFWJgSb0MKrkbfc';

/** 同期対象のエリアID一覧 */
const MANAGED_AREAS = [
  'magic_supply', 'saint_supply',
  // プレイヤーエリアは動的に追加
];

/** エンジンフィールドアクションID → ボードカードdefinitionID のマッピング */
const FIELD_ACTION_CARD_MAP: Record<string, string> = {
  research: 'M110',
  violence: 'M111',
  magic_shop: 'M112',
  cathedral: 'M113',
  sacrifice: 'M114',
  prayer: 'M115',
};

// 通常カウンター実測値: 幅200px, 高さ62px
// readonlyカウンター推定値: 幅80px, 高さ42px
const COUNTER_WIDTH = 200;
const RO_COUNTER_WIDTH = 80;
const COUNTER_GAP = 20;
const RO_COUNTER_GAP = 10;

export class MajoBoardSync {
  private client: BridgeClient;
  private controller: MajoPlayController | null = null;
  /** エンジンカードID → ボードインスタンスID のキャッシュ */
  private instanceCache: Map<string, string> = new Map();
  /** プレイヤーID → マナカウンターID */
  private manaCounters: Map<string, string> = new Map();
  /** プレイヤーID → タップマナカウンターID */
  private tapManaCounters: Map<string, string> = new Map();
  /** プレイヤーID → VPカウンターID */
  private vpCounters: Map<string, string> = new Map();
  /** プレイヤーID → SPカウンターID */
  private spCounters: Map<string, string> = new Map();
  /** 管理対象エリア一覧（初期化時に構築） */
  private managedAreas: string[] = [];

  constructor(client: BridgeClient) {
    this.client = client;
  }

  /** コントローラーを設定し、ボードからのアクション選択を接続する */
  setController(ctrl: MajoPlayController): void {
    this.controller = ctrl;
    this.client.onMajoAction((index: number) => {
      if (this.controller) {
        this.controller.selectAction(index);
      }
    });
  }

  /** ボード初期化: suppressIncomingを有効にし、カウンターを作成し、初期状態を同期 */
  async init(info: MajoGameInfo): Promise<void> {
    this.client.setSuppressIncoming(true);
    this.client.setHumanSlot(info.humanPlayerId);


    // 管理対象エリアを構築
    this.managedAreas = [...MANAGED_AREAS];
    for (const p of info.players) {
      this.managedAreas.push(
        `p_tools_${p.id}`, `p_saints_${p.id}`, `p_relics_${p.id}`,
      );
    }

    // フィールドアクションカードを2段×3列に再配置
    this.arrangeFieldCards();

    this.createCounters(info);
    this.syncBoard(info);
  }

  /** ゲーム状態の変更をボードに反映 */
  sync(info: MajoGameInfo): void {
    this.syncBoard(info);
  }

  /** クリーンアップ: suppress解除、アナウンス消去 */
  cleanup(): void {
    this.client.setSuppressIncoming(false);
    this.client.setAnnouncement(null);
    this.client.setHumanSlot(null);
    this.client.setMajoActions(null);
    this.client.setMajoGameInfo(null);
    this.client.onMajoAction(null);
    this.controller = null;
    this.client.sendState();
  }

  // ── Private ──

  /** フィールドアクションカードを2段×3列に再配置 */
  private arrangeFieldCards(): void {
    const fieldArea = this.client.getArea('field');
    if (!fieldArea) return;

    const areaX = fieldArea.x * 10; // px
    const areaY = fieldArea.y * 10;
    const areaH = fieldArea.height * 10;

    // 2段の縦配置: standardカード176px高, colStep=140px
    // スロットインジケーター分(30px)を考慮した行間=50px
    // 2段合計 = 176 + 50(隙間) + 176 = 402px
    const ROW_GAP = 50;
    const topMargin = Math.max(0, Math.floor((areaH - (MAJO_CARD_HEIGHT * 2 + ROW_GAP)) / 2));
    const row1Y = areaY + topMargin;
    const row2Y = row1Y + MAJO_CARD_HEIGHT + ROW_GAP;

    const actionIds = Object.keys(FIELD_ACTION_CARD_MAP);
    for (let i = 0; i < actionIds.length; i++) {
      const defId = FIELD_ACTION_CARD_MAP[actionIds[i]];
      const instances = this.client.getCardsByDefinition(defId);
      if (instances.length === 0) continue;

      const col = i % 3;       // 0, 1, 2
      const row = Math.floor(i / 3); // 0 or 1
      const x = areaX + 4 + col * MAJO_COL_STEP;  // 140px間隔
      const y = row === 0 ? row1Y : row2Y;

      this.client.moveCardToPosition(instances[0].instanceId, x, y, true);
    }
  }

  /** マナ・VP・フィールドスロットカウンターをボード状態に動的追加 */
  private createCounters(info: MajoGameInfo): void {
    const state = this.client.getState();
    const counters = state.counters as Record<string, any>;

    for (const p of info.players) {
      const witchArea = this.client.getArea(`p_witch_${p.id}`);
      if (!witchArea) continue;

      const areaPixelW = witchArea.width * 10;
      // カード2枚右端（タップ時の横倒し幅176pxを考慮）:
      const cardsEndX = 4 + MAJO_COL_STEP + MAJO_CARD_HEIGHT; // 320px
      // readonlyカウンター3つ横並び: 80*3 + 10*2 = 260px
      const countersWidth = RO_COUNTER_WIDTH * 3 + RO_COUNTER_GAP * 2;
      const fitsRight = (areaPixelW - cardsEndX - COUNTER_GAP) >= countersWidth;

      let baseX: number, baseY: number;

      if (fitsRight) {
        // カード右に横3列配置
        baseX = witchArea.x * 10 + cardsEndX + COUNTER_GAP;
        baseY = (witchArea.y + witchArea.height / 2) * 10 - 21; // カウンター高さ42pxの中央
      } else {
        // 狭いエリア: 魔女エリアの上に配置
        baseY = witchArea.y * 10 - 42 - 10; // カウンター高さ42px + マージン10px
        baseX = witchArea.x * 10 + 4;
      }

      const step = RO_COUNTER_WIDTH + RO_COUNTER_GAP; // 90px間隔

      // マナカウンター（表示専用）
      const manaId = `mana_${p.id}`;
      counters[manaId] = {
        counterId: manaId,
        name: `${p.name} マナ`,
        value: p.mana,
        min: 0, max: 99, step: 1,
        x: baseX, y: baseY,
        readonly: true,
      };
      this.manaCounters.set(p.id, manaId);

      // タップマナカウンター（表示専用）
      const tapManaId = `tap_mana_${p.id}`;
      counters[tapManaId] = {
        counterId: tapManaId,
        name: `${p.name} Tap`,
        value: p.tappedMana,
        min: 0, max: 99, step: 1,
        x: baseX + step, y: baseY,
        readonly: true,
      };
      this.tapManaCounters.set(p.id, tapManaId);

      // VPカウンター（表示専用）
      const vpId = `vp_${p.id}`;
      counters[vpId] = {
        counterId: vpId,
        name: `${p.name} VP`,
        value: p.vp,
        min: 0, max: 99, step: 1,
        x: baseX + step * 2, y: baseY,
        readonly: true,
      };
      this.vpCounters.set(p.id, vpId);

      // SPカウンター（スタートプレイヤー表示、持ってる人だけ値1）
      const spId = `sp_${p.id}`;
      counters[spId] = {
        counterId: spId,
        name: `SP`,
        value: p.hasStartPlayer ? 1 : 0,
        min: 0, max: 1, step: 1,
        x: baseX + step * 3, y: baseY,
        readonly: true,
      };
      this.spCounters.set(p.id, spId);
    }

    // スロットカウンターは廃止（200px幅のカウンターが100px間隔に収まらないため）
    // スロット情報はアナウンステキストに含める
  }

  /** 完全同期: ゲーム状態をすべてボードに反映 */
  private syncBoard(info: MajoGameInfo): void {
    const placedInstanceIds = new Set<string>();

    // 魔導具展示
    if (info.toolSupply.length !== 3) {
      console.warn(`[majo-board] toolSupply枚数異常: ${info.toolSupply.length}枚 (期待3枚)`, info.toolSupply.map(t => t.id));
    }
    this.placeCards(info.toolSupply.map((t) => t.id), 'magic_supply', true, placedInstanceIds);

    // 聖者展示
    this.placeCards(info.saintSupply.map((s) => s.id), 'saint_supply', true, placedInstanceIds);

    // 各プレイヤーのエリア
    for (const p of info.players) {
      // 魔導具: タップ状態を渡して横倒し表示
      this.placeCards(
        p.tools.map((t) => t.id), `p_tools_${p.id}`, true, placedInstanceIds,
        p.tools.map((t) => t.tapped),
      );
      this.placeCards(p.saints.map((s) => s.id), `p_saints_${p.id}`, true, placedInstanceIds);
      const relicIds = p.relics.map((r) => r.id);
      // 獲得済み実績カードも聖遺物エリアに配置
      if (p.achievements) {
        relicIds.push(...p.achievements.map((a) => a.id));
      }
      this.placeCards(relicIds, `p_relics_${p.id}`, true, placedInstanceIds);

      // 魔女カード(M33)・使い魔(M37)のタップ表示
      this.syncWitchCard(p);
      this.syncFamiliarCard(p);
    }

    // 管理対象エリア内の不要カードを山札に戻す
    for (const areaId of this.managedAreas) {
      const cardsInArea = this.client.getCardsInArea(areaId);
      for (const card of cardsInArea) {
        if (!placedInstanceIds.has(card.instanceId)) {
          this.returnToDeck(card.instanceId, card.definitionId);
        }
      }
    }

    // 以前配置済みだが現在不要なカードを山札に戻す
    for (const [engineId, instanceId] of this.instanceCache) {
      if (!placedInstanceIds.has(instanceId)) {
        this.returnToDeck(instanceId, engineId);
      }
    }
    for (const [engineId, instanceId] of [...this.instanceCache]) {
      if (!placedInstanceIds.has(instanceId)) {
        this.instanceCache.delete(engineId);
      }
    }

    // 配置不要な表向きカードを山札に裏向きで戻す
    // ただし以下は除外:
    //   - placedInstanceIds（展示・プレイヤーエリアに配置済み）
    //   - フィールドアクションカード
    //   - スタック内カード（既に山札に入っている）
    //   - 魔女(M33)・使い魔(M37)（p_witchに初期配置、エンジン管理外）
    //   - 実績カード(M126-M130)（achievementエリアに初期配置）
    const KEEP_DEF_IDS = new Set(['M33', 'M37', 'M126', 'M127', 'M128', 'M129', 'M130']);
    const fieldCardIds = new Set<string>();
    for (const defId of Object.values(FIELD_ACTION_CARD_MAP)) {
      for (const inst of this.client.getCardsByDefinition(defId)) {
        fieldCardIds.add(inst.instanceId);
      }
    }
    const state = this.client.getState();
    const inStack = new Set<string>();
    for (const stack of Object.values(state.cardStacks)) {
      for (const cid of (stack as any).cardInstanceIds || []) {
        inStack.add(cid);
      }
    }
    for (const inst of Object.values(state.cardInstances)) {
      if (placedInstanceIds.has(inst.instanceId)) continue;
      if (fieldCardIds.has(inst.instanceId)) continue;
      if (inStack.has(inst.instanceId)) continue;
      if (KEEP_DEF_IDS.has(inst.definitionId)) continue;
      this.returnToDeck(inst.instanceId, inst.definitionId);
    }

    // カウンター更新
    this.updatePlayerCounters(info);

    // アナウンス
    this.client.setAnnouncement(this.buildAnnouncement(info));

    // 人間ターンならアクション選択肢をボードに送信
    if (info.isHumanTurn && info.availableActions.length > 0) {
      this.client.setMajoActions(info.availableActions.map((a) => ({
        index: a.index,
        description: a.description,
        category: a.category,
      })));
    } else {
      this.client.setMajoActions(null);
    }

    // ゲーム情報全体をボードに送信（ゲーム情報パネル用）
    // 人間ターン時はlastEventsをクリア（AIアクションオーバーレイが消えなくなるのを防止）
    const infoForBoard = { ...info };
    if (info.isHumanTurn) {
      infoForBoard.lastEvents = [];
    }
    this.client.setMajoGameInfo(infoForBoard as unknown as Record<string, unknown>);

    this.client.sendState();
  }

  /** プレイヤーのマナ・タップマナ・VPカウンターを更新 */
  private updatePlayerCounters(info: MajoGameInfo): void {
    for (const p of info.players) {
      const manaId = this.manaCounters.get(p.id);
      if (manaId) {
        try { this.client.updateCounter(manaId, p.mana); } catch { /* ignore */ }
      }
      const tapManaId = this.tapManaCounters.get(p.id);
      if (tapManaId) {
        try { this.client.updateCounter(tapManaId, p.tappedMana); } catch { /* ignore */ }
      }
      const vpId = this.vpCounters.get(p.id);
      if (vpId) {
        try { this.client.updateCounter(vpId, p.vp); } catch { /* ignore */ }
      }
      const spId = this.spCounters.get(p.id);
      if (spId) {
        try { this.client.updateCounter(spId, p.hasStartPlayer ? 1 : 0); } catch { /* ignore */ }
      }
    }
  }


  /** カードを適切な山札エリアに裏向きで戻す */
  private returnToDeck(instanceId: string, definitionId: string): void {
    let deckAreaId = 'magic_deck';
    if (definitionId.startsWith('TK')) {
      deckAreaId = 'coin_deck'; // トークンはコインデッキへ
    } else {
      const num = parseInt(definitionId.replace(/^M/, ''), 10);
      if (!isNaN(num)) {
        if (num >= 41 && num <= 67) {
          deckAreaId = 'relic_deck';
        } else if (num >= 71 && num <= 94) {
          deckAreaId = 'saint_deck';
        }
      }
    }

    try {
      this.client.moveCardToArea(instanceId, deckAreaId, false, 0);
    } catch {
      try {
        this.client.discardCard(instanceId);
      } catch { /* ignore */ }
    }
  }

  /** エンジンカードIDリストをボードエリアに配置（standardカード用座標計算） */
  private placeCards(
    engineIds: string[],
    areaId: string,
    faceUp: boolean,
    placedInstanceIds: Set<string>,
    tappedFlags?: boolean[],
  ): void {
    const area = this.client.getArea(areaId);
    if (!area) return;

    const areaPixelX = area.x * 10;
    const areaPixelW = area.width * 10;

    // standardカード用spacing: colStep=140だがエリア幅に応じて縮小
    // タップカード（横倒し）は実質幅がMAJO_CARD_HEIGHTになるので考慮
    const hasTapped = tappedFlags?.some(Boolean) ?? false;
    const effectiveCardWidth = hasTapped ? MAJO_CARD_HEIGHT : MAJO_CARD_WIDTH;
    const spacing = engineIds.length > 1
      ? Math.min(MAJO_COL_STEP + (hasTapped ? 40 : 0), Math.floor((areaPixelW - effectiveCardWidth) / (engineIds.length - 1)))
      : MAJO_COL_STEP;

    for (let i = 0; i < engineIds.length; i++) {
      const engineId = engineIds[i];
      const instanceId = this.resolveInstance(engineId);
      if (!instanceId) continue;
      placedInstanceIds.add(instanceId);

      const isTapped = tappedFlags?.[i] ?? false;
      const cardX = areaPixelX + 4 + i * spacing;
      const cardY = (area.y + area.height / 2) * 10 - MAJO_CARD_HEIGHT / 2;

      try {
        this.client.moveCardToPosition(instanceId, cardX, cardY, faceUp, isTapped ? 90 : 0);
      } catch {
        // ignore
      }
    }
  }

  /** エンジンカードIDからボードインスタンスIDを解決（キャッシュ付き、なければ動的生成） */
  private resolveInstance(engineId: string): string | null {
    if (this.instanceCache.has(engineId)) {
      return this.instanceCache.get(engineId)!;
    }
    const instances = this.client.getCardsByDefinition(engineId);

    const used = new Set(this.instanceCache.values());
    for (const inst of instances) {
      if (!used.has(inst.instanceId)) {
        this.instanceCache.set(engineId, inst.instanceId);
        return inst.instanceId;
      }
    }

    // ボードにインスタンスが存在しない場合は動的生成
    console.warn(`[majo-board] resolveInstance動的生成: ${engineId} (ボードに既存インスタンスなし)`);
    const newInstanceId = this.client.createCardInstance(engineId);
    this.instanceCache.set(engineId, newInstanceId);
    return newInstanceId;
  }

  /** 魔女カード(M33)のタップ/アンタップ表示を同期 */
  private syncWitchCard(player: MajoGameInfo['players'][number]): void {
    // 各プレイヤーのp_witchエリアにあるM33カードを見つけて回転
    const witchInstances = this.client.getCardsByDefinition('M33');
    const witchArea = this.client.getArea(`p_witch_${player.id}`);
    if (!witchArea || witchInstances.length === 0) return;

    const areaPixelX = witchArea.x * 10;
    const areaPixelW = witchArea.width * 10;
    const areaPixelY = witchArea.y * 10;
    const areaPixelH = witchArea.height * 10;

    // このプレイヤーエリア内の魔女カードを探す
    for (const inst of witchInstances) {
      if (inst.x >= areaPixelX && inst.x < areaPixelX + areaPixelW &&
          inst.y >= areaPixelY && inst.y < areaPixelY + areaPixelH) {
        const rotation = player.witchUsed ? 90 : 0;
        if (inst.rotation !== rotation) {
          try {
            this.client.moveCardToPosition(inst.instanceId, inst.x, inst.y, true, rotation);
          } catch { /* ignore */ }
        }
        break;
      }
    }
  }

  /** 使い魔カード(M37)のタップ/アンタップ表示を同期 */
  private syncFamiliarCard(player: MajoGameInfo['players'][number]): void {
    const familiarInstances = this.client.getCardsByDefinition('M37');
    const witchArea = this.client.getArea(`p_witch_${player.id}`);
    if (!witchArea || familiarInstances.length === 0) return;

    const areaPixelX = witchArea.x * 10;
    const areaPixelW = witchArea.width * 10;
    const areaPixelY = witchArea.y * 10;
    const areaPixelH = witchArea.height * 10;

    for (const inst of familiarInstances) {
      if (inst.x >= areaPixelX && inst.x < areaPixelX + areaPixelW &&
          inst.y >= areaPixelY && inst.y < areaPixelY + areaPixelH) {
        const rotation = player.familiarUsed ? 90 : 0;
        if (inst.rotation !== rotation) {
          try {
            this.client.moveCardToPosition(inst.instanceId, inst.x, inst.y, true, rotation);
          } catch { /* ignore */ }
        }
        break;
      }
    }
  }

  /** アナウンステキスト構築 */
  private buildAnnouncement(info: MajoGameInfo): string {
    if (info.gameOver) {
      if (info.finalScores && info.finalScores.length > 0) {
        const lines = info.finalScores.map((s) => {
          const human = s.playerId === info.humanPlayerId ? ' (YOU)' : '';
          return `${s.rank}位 ${s.name}: ${s.victoryPoints}VP${human}`;
        });
        return `GAME OVER! ${lines.join(' | ')}`;
      }
      return 'GAME OVER';
    }

    const parts: string[] = [];
    parts.push(`R${info.round} ${info.currentPlayerName}`);

    if (info.lastEvents.length > 0) {
      parts.push(info.lastEvents.slice(0, 2).join(' / '));
    }

    // スロット情報はボード上のスロットインジケーターで表示（アナウンスからは削除）

    return parts.join(' - ');
  }
}
