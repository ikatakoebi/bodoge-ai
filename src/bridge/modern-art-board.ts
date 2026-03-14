/**
 * Modern Art ボード同期
 * BridgeClient経由でゲーム状態をクライアントに送信
 * ボードのカード配置は使わず、パネル（ModernArtPanel）でUI表示する
 */

import type { BridgeClient } from './client.js';
import type { ModernArtGameInfo } from '../engine/modern-art-types.js';

export class ModernArtBoardSync {
  private client: BridgeClient;

  constructor(client: BridgeClient) {
    this.client = client;
  }

  sync(info: ModernArtGameInfo): void {
    // アナウンス
    let announcement = '';
    if (info.gameOver) {
      announcement = 'ゲーム終了';
    } else if (info.auctionState) {
      const a = info.auctionState;
      const typeLabel = {
        open: '公開競り',
        once_around: '一巡競り',
        sealed: '密封入札',
        fixed_price: '固定価格',
        double: 'ダブル',
      }[a.auctionType];
      announcement = `R${info.round} — ${a.artist} ${typeLabel}${a.isDouble ? '(ダブル)' : ''} — ${a.sellerName}出品`;
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
    this.client.setAnnouncement(null);
    this.client.setModernArtGameInfo(null);
  }
}
