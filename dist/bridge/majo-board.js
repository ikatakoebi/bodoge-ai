/**
 * MajoBoardSync — 魔女ゲーのボード同期
 * MajoPlayController のゲーム状態を BridgeClient 経由でボードに反映する
 */
/** 魔女ゲースプレッドシートID */
export const MAJO_SHEET_ID = '1h7iwwlbE6_QBd3ClFFAW-PrgVx0quFWJgSb0MKrkbfc';
/** 同期対象のエリアID一覧 */
const MANAGED_AREAS = [
    'magic_supply', 'saint_supply',
    // プレイヤーエリアは動的に追加
];
/** エンジンフィールドアクションID → ボードカードdefinitionID のマッピング */
const FIELD_ACTION_CARD_MAP = {
    research: 'M110',
    violence: 'M111',
    magic_shop: 'M112',
    cathedral: 'M113',
    sacrifice: 'M114',
    prayer: 'M115',
};
export class MajoBoardSync {
    client;
    /** エンジンカードID → ボードインスタンスID のキャッシュ */
    instanceCache = new Map();
    /** プレイヤーID → マナカウンターID */
    manaCounters = new Map();
    /** プレイヤーID → VPカウンターID */
    vpCounters = new Map();
    /** フィールドアクションID → スロットカウンターID */
    slotCounters = new Map();
    /** 管理対象エリア一覧（初期化時に構築） */
    managedAreas = [];
    constructor(client) {
        this.client = client;
    }
    /** ボード初期化: suppressIncomingを有効にし、カウンターを作成し、初期状態を同期 */
    async init(info) {
        this.client.setSuppressIncoming(true);
        this.client.setHumanSlot(info.humanPlayerId);
        // 管理対象エリアを構築
        this.managedAreas = [...MANAGED_AREAS];
        for (const p of info.players) {
            this.managedAreas.push(`p_tools_${p.id}`, `p_saints_${p.id}`, `p_relics_${p.id}`);
        }
        this.createCounters(info);
        this.syncBoard(info);
    }
    /** ゲーム状態の変更をボードに反映 */
    sync(info) {
        this.syncBoard(info);
    }
    /** クリーンアップ: suppress解除、アナウンス消去 */
    cleanup() {
        this.client.setSuppressIncoming(false);
        this.client.setAnnouncement(null);
        this.client.setHumanSlot(null);
        this.client.sendState();
    }
    // ── Private ──
    /** マナ・VP・フィールドスロットカウンターをボード状態に動的追加 */
    createCounters(info) {
        const state = this.client.getState();
        const counters = state.counters;
        // プレイヤーカウンター（マナ・VP）
        for (const p of info.players) {
            // 魔女エリア（p_witch_pX）の下にカウンターを配置
            const witchArea = this.client.getArea(`p_witch_${p.id}`);
            const toolsArea = this.client.getArea(`p_tools_${p.id}`);
            const refArea = witchArea || toolsArea;
            if (!refArea)
                continue;
            // エリアの左下に配置（カードと被らないように下方向にオフセット）
            const baseX = refArea.x * 10;
            const baseY = (refArea.y + refArea.height) * 10 + 10;
            // マナカウンター
            const manaId = `mana_${p.id}`;
            counters[manaId] = {
                counterId: manaId,
                name: `${p.name} マナ`,
                value: p.mana,
                min: 0,
                max: 99,
                step: 1,
                x: baseX,
                y: baseY,
            };
            this.manaCounters.set(p.id, manaId);
            // VPカウンター（マナの右隣）
            const vpId = `vp_${p.id}`;
            counters[vpId] = {
                counterId: vpId,
                name: `${p.name} VP`,
                value: p.vp,
                min: 0,
                max: 99,
                step: 1,
                x: baseX + 120,
                y: baseY,
            };
            this.vpCounters.set(p.id, vpId);
        }
        // フィールドアクションスロットカウンター
        for (const fa of info.fieldActions) {
            const cardDefId = FIELD_ACTION_CARD_MAP[fa.id];
            if (!cardDefId)
                continue;
            // フィールドアクションカードの位置を取得
            const cardInstances = this.client.getCardsByDefinition(cardDefId);
            if (cardInstances.length === 0)
                continue;
            const card = cardInstances[0];
            // カードの下にスロットカウンターを配置
            const slotId = `slot_${fa.id}`;
            const maxLabel = fa.maxSlots < 0 ? '∞' : `${fa.maxSlots}`;
            counters[slotId] = {
                counterId: slotId,
                name: `${fa.name} ${fa.usedSlots}/${maxLabel}`,
                value: fa.usedSlots,
                min: 0,
                max: fa.maxSlots < 0 ? 99 : fa.maxSlots,
                step: 1,
                x: card.x,
                y: card.y + 140, // カードの下（CARD_HEIGHT=126 + マージン）
            };
            this.slotCounters.set(fa.id, slotId);
        }
    }
    /** 完全同期: ゲーム状態をすべてボードに反映 */
    syncBoard(info) {
        // 今回配置するインスタンスIDを記録
        const placedInstanceIds = new Set();
        // 魔導具展示
        this.placeCards(info.toolSupply.map((t) => t.id), 'magic_supply', true, placedInstanceIds);
        // 聖者展示
        this.placeCards(info.saintSupply.map((s) => s.id), 'saint_supply', true, placedInstanceIds);
        // 各プレイヤーのエリア
        for (const p of info.players) {
            this.placeCards(p.tools.map((t) => t.id), `p_tools_${p.id}`, true, placedInstanceIds);
            this.placeCards(p.saints.map((s) => s.id), `p_saints_${p.id}`, true, placedInstanceIds);
            this.placeCards(p.relics.map((r) => r.id), `p_relics_${p.id}`, true, placedInstanceIds);
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
        // キャッシュから削除
        for (const [engineId, instanceId] of [...this.instanceCache]) {
            if (!placedInstanceIds.has(instanceId)) {
                this.instanceCache.delete(engineId);
            }
        }
        // カウンター更新
        this.updatePlayerCounters(info);
        this.updateSlotCounters(info);
        // アナウンス
        this.client.setAnnouncement(this.buildAnnouncement(info));
        this.client.sendState();
    }
    /** プレイヤーのマナ・VPカウンターを更新 */
    updatePlayerCounters(info) {
        for (const p of info.players) {
            const manaId = this.manaCounters.get(p.id);
            if (manaId) {
                try {
                    this.client.updateCounter(manaId, p.mana);
                }
                catch { /* ignore */ }
            }
            const vpId = this.vpCounters.get(p.id);
            if (vpId) {
                try {
                    this.client.updateCounter(vpId, p.vp);
                }
                catch { /* ignore */ }
            }
        }
    }
    /** フィールドアクションのスロットカウンターを更新 */
    updateSlotCounters(info) {
        const state = this.client.getState();
        const counters = state.counters;
        for (const fa of info.fieldActions) {
            const slotId = this.slotCounters.get(fa.id);
            if (!slotId || !counters[slotId])
                continue;
            const maxLabel = fa.maxSlots < 0 ? '∞' : `${fa.maxSlots}`;
            counters[slotId].name = `${fa.name} ${fa.usedSlots}/${maxLabel}`;
            counters[slotId].value = fa.usedSlots;
        }
    }
    /** カードを適切な山札エリアに裏向きで戻す */
    returnToDeck(instanceId, definitionId) {
        // definitionId のプレフィックスで山札エリアを判定
        // M1-M28: 魔導具 → magic_deck
        // M71-M94: 聖者 → saint_deck
        // M41-M67: レリック → relic_deck
        let deckAreaId = 'magic_deck'; // デフォルト
        const num = parseInt(definitionId.replace(/^M/, ''), 10);
        if (!isNaN(num)) {
            if (num >= 41 && num <= 67) {
                deckAreaId = 'relic_deck';
            }
            else if (num >= 71 && num <= 94) {
                deckAreaId = 'saint_deck';
            }
        }
        try {
            this.client.moveCardToArea(instanceId, deckAreaId, false, 0);
        }
        catch {
            // エリアが見つからない場合はオフスクリーンに移動
            try {
                this.client.discardCard(instanceId);
            }
            catch { /* ignore */ }
        }
    }
    /** エンジンカードIDリストをボードエリアに配置 */
    placeCards(engineIds, areaId, faceUp, placedInstanceIds) {
        for (let i = 0; i < engineIds.length; i++) {
            const engineId = engineIds[i];
            const instanceId = this.resolveInstance(engineId);
            if (!instanceId)
                continue;
            placedInstanceIds.add(instanceId);
            try {
                this.client.moveCardToArea(instanceId, areaId, faceUp, i);
            }
            catch {
                // ignore
            }
        }
    }
    /** エンジンカードIDからボードインスタンスIDを解決（キャッシュ付き） */
    resolveInstance(engineId) {
        if (this.instanceCache.has(engineId)) {
            return this.instanceCache.get(engineId);
        }
        const instances = this.client.getCardsByDefinition(engineId);
        if (instances.length === 0)
            return null;
        // 未割り当てのインスタンスを使用
        const used = new Set(this.instanceCache.values());
        for (const inst of instances) {
            if (!used.has(inst.instanceId)) {
                this.instanceCache.set(engineId, inst.instanceId);
                return inst.instanceId;
            }
        }
        return null;
    }
    /** アナウンステキスト構築 */
    buildAnnouncement(info) {
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
        const parts = [];
        parts.push(`R${info.round} ${info.currentPlayerName}`);
        if (info.isHumanTurn) {
            parts.push('YOUR TURN');
        }
        // 最新イベント
        if (info.lastEvents.length > 0) {
            parts.push(info.lastEvents.slice(0, 2).join(' / '));
        }
        return parts.join(' - ');
    }
}
