/**
 * Modern Art ボード同期
 * エンジンのゲーム状態をBridgeClient経由でボードのカード配置に反映する
 */

import type { BridgeClient } from './client.js';
import type { ModernArtGameInfo } from '../engine/modern-art-types.js';

const COL_STEP = 140; // px (colStep = 14単位 × 10px)
const ROW_STEP = 190; // px (rowStep = 19単位 × 10px)
const CARD_HEIGHT = 176;

export class ModernArtBoardSync {
  private client: BridgeClient;
  /** engineCardId → boardInstanceId */
  private instanceCache: Map<string, string> = new Map();
  private humanPlayerId: string | null = null;

  constructor(client: BridgeClient) {
    this.client = client;
  }

  init(info: ModernArtGameInfo): void {
    this.client.setSuppressIncoming(true);
    this.humanPlayerId = info.humanPlayerId;
    this.sync(info);
  }

  sync(info: ModernArtGameInfo): void {
    const placed = new Set<string>();

    // 1. 人間プレイヤーの手札 → p_hand_p{index} に表向き配置
    const humanIdx = info.players.findIndex(p => p.id === info.humanPlayerId);
    if (humanIdx >= 0 && info.myHand) {
      this.placeCards(
        info.myHand.map(c => c.id),
        `p_hand_p${humanIdx}`,
        true, // faceUp
        placed,
      );
    }

    // 2. AIプレイヤーの手札 → 裏向きカード（枚数分）
    for (let i = 0; i < info.players.length; i++) {
      const p = info.players[i];
      if (p.id === info.humanPlayerId) continue;
      // AIの手札はカードIDが分からないので、ダミーIDで裏向き表示
      const dummyIds: string[] = [];
      for (let j = 0; j < p.handCount; j++) {
        dummyIds.push(`__ai_hand_${p.id}_${j}`);
      }
      this.placeCards(dummyIds, `p_hand_p${i}`, false, placed);
    }

    // 3. オークション中のカード → auction エリア
    if (info.auctionState) {
      // auctionStateからカードIDを特定するのは難しいが、表示用に1枚出す
      const auctionDummyId = `__auction_current`;
      this.placeCards([auctionDummyId], 'auction', true, placed);
    }

    // 4. アナウンス
    let announcement = '';
    if (info.gameOver) {
      announcement = 'ゲーム終了';
    } else if (info.auctionState) {
      const a = info.auctionState;
      const typeLabel: Record<string, string> = {
        open: '公開競り', once_around: '一巡競り', sealed: '密封入札',
        fixed_price: '固定価格', double: 'ダブル',
      };
      announcement = `R${info.round} — ${a.artist} ${typeLabel[a.auctionType] || a.auctionType}${a.isDouble ? '(ダブル)' : ''} — ${a.sellerName}出品`;
      if (a.currentBid > 0 && a.currentBidderName) {
        announcement += ` — 現在${a.currentBid}(${a.currentBidderName})`;
      }
    } else {
      announcement = `R${info.round} — ${info.currentPlayerName}のターン`;
    }

    this.client.setAnnouncement(announcement);
    this.client.setModernArtGameInfo(info as unknown as Record<string, unknown>);
    this.client.sendState();
  }

  cleanup(): void {
    this.client.setSuppressIncoming(false);
    this.client.setAnnouncement(null);
    this.client.setModernArtGameInfo(null);
    this.client.sendState();
  }

  // ── Private ──

  private placeCards(
    cardIds: string[],
    areaId: string,
    faceUp: boolean,
    placed: Set<string>,
  ): void {
    const area = this.client.getArea(areaId);
    if (!area) return;

    const areaPixelX = area.x * 10;
    const areaPixelY = area.y * 10;
    const areaPixelW = area.width * 10;

    // executeSetupと同じグリッド配置: colStep間隔で折り返し
    const maxCols = Math.max(1, Math.floor(areaPixelW / COL_STEP));

    for (let i = 0; i < cardIds.length; i++) {
      const cardId = cardIds[i];
      const instanceId = this.resolveInstance(cardId);
      if (!instanceId) continue;
      placed.add(instanceId);

      const col = i % maxCols;
      const row = Math.floor(i / maxCols);
      const x = areaPixelX + 4 + col * COL_STEP;
      const y = areaPixelY + 4 + row * ROW_STEP;

      try {
        this.client.moveCardToPosition(instanceId, x, y, faceUp);
      } catch { /* ignore */ }
    }
  }

  private resolveInstance(cardId: string): string | null {
    // キャッシュ済み
    if (this.instanceCache.has(cardId)) {
      return this.instanceCache.get(cardId)!;
    }

    // ダミーID（AI手札等）は常に動的生成
    if (cardId.startsWith('__')) {
      const newId = this.client.createCardInstance('MA01'); // 任意の定義で生成
      this.instanceCache.set(cardId, newId);
      return newId;
    }

    // 実カードID → ボード上の既存インスタンスを探す
    const instances = this.client.getCardsByDefinition(cardId);
    const used = new Set(this.instanceCache.values());
    for (const inst of instances) {
      if (!used.has(inst.instanceId)) {
        this.instanceCache.set(cardId, inst.instanceId);
        return inst.instanceId;
      }
    }

    // なければ動的生成
    const newId = this.client.createCardInstance(cardId);
    this.instanceCache.set(cardId, newId);
    return newId;
  }
}
