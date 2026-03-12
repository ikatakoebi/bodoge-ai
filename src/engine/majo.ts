// 魔女ゲー ゲームエンジン

import type { PlayerConfig } from './types.js';
import type {
  MajoGameState, MajoPlayerState, MajoAction, FieldActionDetails,
  FieldAction, FieldActionId, MajoToolCard, MajoSaintCard, MajoRelicCard,
  MajoFinalScore, MajoAchievementCard,
} from './majo-types.js';
import { ALL_TOOLS, ALL_SAINTS, ALL_RELICS, ALL_ACHIEVEMENTS } from './majo-cards.js';

const INITIAL_MANA = 3;
const VICTORY_POINT_TARGET = 7;

function shuffle<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// ── 初期化 ──

function createFieldActions(): FieldAction[] {
  return [
    { id: 'research',    name: '研究',   maxSlots: 3,  cost: 'variable', usedSlots: 0 },
    { id: 'violence',    name: '横暴',   maxSlots: 3,  cost: 2,          usedSlots: 0 },
    { id: 'magic_shop',  name: '魔具店', maxSlots: 3,  cost: 1,          usedSlots: 0 },
    { id: 'cathedral',   name: '大聖堂', maxSlots: 1,  cost: 1,          usedSlots: 0 },
    { id: 'sacrifice',   name: '生贄',   maxSlots: -1, cost: 5,          usedSlots: 0 }, // 無制限
    { id: 'prayer',      name: '祈祷',   maxSlots: 3,  cost: 1,          usedSlots: 0 },
  ];
}

export function createMajoGame(players: PlayerConfig[]): MajoGameState {
  if (players.length < 2 || players.length > 4) {
    throw new Error('プレイヤー数は2〜4人');
  }

  const shuffledSaints = shuffle([...ALL_SAINTS]);
  const shuffledRelics = shuffle([...ALL_RELICS]);

  const playerStates: MajoPlayerState[] = players.map((config) => ({
    config,
    mana: INITIAL_MANA,
    tappedMana: 0,          // ゲーム開始時のマナはアンタップ状態
    magicTools: [],
    tappedToolIds: [],
    saints: [],
    relics: [],
    witchTapped: false,
    familiarTapped: false,
    victoryPoints: 0,
    lastPassiveVP: 0,
    passed: false,
  }));

  const shuffledTools = shuffle([...ALL_TOOLS]);

  const initialState: MajoGameState = {
    players: playerStates,
    toolDeck: shuffledTools.slice(3),       // 残りデッキ
    toolSupply: shuffledTools.slice(0, 3),  // 展示3枚
    saintSupply: shuffledSaints.splice(0, 3),
    saintDeck: shuffledSaints,
    relicDeck: shuffledRelics,
    achievements: [...ALL_ACHIEVEMENTS],
    fieldActions: createFieldActions(),
    round: 1,
    currentPlayerIndex: 0,
    startPlayerIndex: 0,
    witchUsageCount: 0,
    consecutivePasses: 0,
    phase: 'action',
    history: [],
    lastEvents: [],
  };

  // 最後のプレイヤー（後手番補正）：マナ+1ボーナス
  const lastIndex = players.length - 1;
  initialState.players = initialState.players.map((p, i) =>
    i === lastIndex ? { ...p, mana: p.mana + 1 } : p
  );

  return initialState;
}

// ── ユーティリティ ──

export function getCurrentPlayer(state: MajoGameState): MajoPlayerState {
  return state.players[state.currentPlayerIndex];
}

export function getPlayer(state: MajoGameState, playerId: string): MajoPlayerState {
  const p = state.players.find((p) => p.config.id === playerId);
  if (!p) throw new Error(`プレイヤー ${playerId} が見つからない`);
  return p;
}

function updatePlayer(state: MajoGameState, playerId: string, update: Partial<MajoPlayerState>): MajoGameState {
  return {
    ...state,
    players: state.players.map((p) =>
      p.config.id === playerId ? { ...p, ...update } : p
    ),
  };
}

function getField(state: MajoGameState, fieldId: FieldActionId): FieldAction {
  const f = state.fieldActions.find((f) => f.id === fieldId);
  if (!f) throw new Error(`フィールド ${fieldId} が見つからない`);
  return f;
}

function updateField(state: MajoGameState, fieldId: FieldActionId, update: Partial<FieldAction>): MajoGameState {
  return {
    ...state,
    fieldActions: state.fieldActions.map((f) =>
      f.id === fieldId ? { ...f, ...update } : f
    ),
  };
}

// 魔導具の実効魔力（M26の杖の特殊効果考慮）
export function getEffectiveMagicPower(tool: MajoToolCard, allTools: MajoToolCard[]): number {
  if (tool.id === 'M26') {
    // 手持ちの最大魔力の魔導具の魔力+3
    const maxPower = Math.max(0, ...allTools.filter((t) => t.id !== 'M26').map((t) => t.magicPower));
    return maxPower + 3;
  }
  return tool.magicPower;
}

// 戦闘魔力の計算
export function calculateCombatPower(
  player: MajoPlayerState,
  tappedToolIds: string[],
  useCombatRelics: string[] = [],
  useWitch: boolean = false,
  witchUsageCount: number = 0,
): number {
  let power = 0;

  // タップした魔導具の魔力合計
  for (const toolId of tappedToolIds) {
    const tool = player.magicTools.find((t) => t.id === toolId);
    if (tool) {
      power += getEffectiveMagicPower(tool, player.magicTools);
      // 護符の戦闘ボーナス
      if (tool.type === '護符' && tool.effect.includes('戦闘：魔力＋3')) {
        power += 3;
      }
    }
  }

  // 戦闘用聖遺物のボーナス
  for (const relicId of useCombatRelics) {
    const relic = player.relics.find((r) => r.id === relicId);
    if (relic && relic.effect.includes('魔力＋2')) {
      power += 2;
    }
  }

  // 魔女ボーナス（魔力モード）
  if (useWitch) {
    power += 3 + witchUsageCount;
  }

  return power;
}

// コスト削減計算（魔導書・水晶玉のタップ効果 + 聖遺物M54）
export function calculateCostReduction(player: MajoPlayerState, toolIdsToTapForDiscount: string[]): number {
  let reduction = 0;

  for (const toolId of toolIdsToTapForDiscount) {
    const tool = player.magicTools.find((t) => t.id === toolId);
    if (tool) {
      if (tool.effect.includes('コスト-2')) reduction += 2;
      else if (tool.effect.includes('コスト-1')) reduction += 1;
    }
  }

  // 聖遺物M54: 魔導具の購入コストが1減る
  if (player.relics.some((r) => r.id === 'M54')) {
    reduction += 1;
  }

  return reduction;
}

// ── アクション可能チェック ──

export function canUseField(state: MajoGameState, fieldId: FieldActionId, useFamiliar: boolean = false): boolean {
  const field = getField(state, fieldId);
  if (field.maxSlots !== -1 && field.usedSlots >= field.maxSlots && !useFamiliar) {
    return false;
  }
  return true;
}

export function getAvailableActions(state: MajoGameState, playerId: string): MajoAction[] {
  const player = getPlayer(state, playerId);
  const actions: MajoAction[] = [];

  // パスは常に可能
  actions.push({ type: 'pass', playerId });

  // 魔女使用
  if (!player.witchTapped) {
    actions.push({ type: 'use_witch', playerId, choice: 'magic' });
    actions.push({ type: 'use_witch', playerId, choice: 'mana' });
  }

  // 使い切り聖遺物の使用（手番タイミング）
  for (const relic of player.relics) {
    if (relic.timing === 'turn' && relic.isDisposable) {
      actions.push({ type: 'use_relic', playerId, relicId: relic.id });
    }
  }

  // M67追加戦闘（フィールド枠・マナコスト不要、魔導具は通常通りタップ必要）
  if (state.extraCombatPlayerId === playerId) {
    const availableTools = player.magicTools.filter((t) => !player.tappedToolIds.includes(t.id));
    const allToolIds = availableTools.map((t) => t.id);
    for (const saint of state.saintSupply) {
      actions.push({ type: 'extra_combat', playerId, saintId: saint.id, tappedToolIds: allToolIds });
    }
  }

  // フィールドアクション
  for (const field of state.fieldActions) {
    const canUse = canUseField(state, field.id);
    const canUseFamiliar = !player.familiarTapped && !canUse && field.usedSlots >= field.maxSlots && field.maxSlots !== -1;

    if (!canUse && !canUseFamiliar) continue;

    const useFamiliar = !canUse && canUseFamiliar;

    switch (field.id) {
      case 'research': {
        // 買える魔導具をリストアップ
        const reduction = calculateCostReduction(player, []);
        for (const tool of state.toolSupply) {
          const effectiveCost = Math.max(1, tool.cost - reduction);
          if (player.mana >= effectiveCost) {
            const details: FieldActionDetails = { action: 'research', toolId: tool.id };
            if (useFamiliar) {
              actions.push({ type: 'use_familiar', playerId, fieldId: 'research', details });
            } else {
              actions.push({ type: 'field_action', playerId, fieldId: 'research', details });
            }
          }
        }
        break;
      }

      case 'violence': {
        if (player.mana >= 2) {
          for (const saint of state.saintSupply) {
            // 全魔導具の組み合わせは膨大なので、タップ可能な全魔導具でまとめる
            const availableTools = player.magicTools.filter((t) => !player.tappedToolIds.includes(t.id));
            const allToolIds = availableTools.map((t) => t.id);
            const details: FieldActionDetails = { action: 'violence', saintId: saint.id, tappedToolIds: allToolIds };
            if (useFamiliar) {
              actions.push({ type: 'use_familiar', playerId, fieldId: 'violence', details });
            } else {
              actions.push({ type: 'field_action', playerId, fieldId: 'violence', details });
            }
          }
        }
        break;
      }

      case 'magic_shop': {
        if (player.mana >= 1) {
          const details: FieldActionDetails = { action: 'magic_shop' };
          if (useFamiliar) {
            actions.push({ type: 'use_familiar', playerId, fieldId: 'magic_shop', details });
          } else {
            actions.push({ type: 'field_action', playerId, fieldId: 'magic_shop', details });
          }
        }
        break;
      }

      case 'cathedral': {
        if (player.mana >= 1) {
          const details: FieldActionDetails = { action: 'cathedral' };
          if (useFamiliar) {
            actions.push({ type: 'use_familiar', playerId, fieldId: 'cathedral', details });
          } else {
            actions.push({ type: 'field_action', playerId, fieldId: 'cathedral', details });
          }
        }
        break;
      }

      case 'sacrifice': {
        if (player.mana >= 5) {
          for (const saint of state.saintSupply) {
            const availableTools = player.magicTools.filter((t) => !player.tappedToolIds.includes(t.id));
            const allToolIds = availableTools.map((t) => t.id);
            const details: FieldActionDetails = { action: 'sacrifice', saintId: saint.id, tappedToolIds: allToolIds };
            if (useFamiliar) {
              actions.push({ type: 'use_familiar', playerId, fieldId: 'sacrifice', details });
            } else {
              actions.push({ type: 'field_action', playerId, fieldId: 'sacrifice', details });
            }
          }
        }
        break;
      }

      case 'prayer': {
        if (player.mana >= 1 && player.relics.some((r) => r.isDisposable)) {
          for (const relic of player.relics.filter((r) => r.isDisposable)) {
            const details: FieldActionDetails = { action: 'prayer', relicId: relic.id };
            if (useFamiliar) {
              actions.push({ type: 'use_familiar', playerId, fieldId: 'prayer', details });
            } else {
              actions.push({ type: 'field_action', playerId, fieldId: 'prayer', details });
            }
          }
        }
        break;
      }
    }
  }

  return actions;
}

// ── アクション実行 ──

export function executeAction(state: MajoGameState, action: MajoAction): MajoGameState {
  // アクション開始時にイベントログをリセット
  let newState: MajoGameState = { ...state, history: [...state.history, action], lastEvents: [] };

  switch (action.type) {
    case 'pass':
      newState = executePass(newState, action.playerId);
      break;

    case 'field_action':
      newState = executeFieldAction(newState, action.playerId, action.fieldId, action.details, false);
      newState.consecutivePasses = 0;
      // M67追加戦闘フラグが立っていたら、同じプレイヤーの手番を続ける
      if (!newState.extraCombatPlayerId) {
        newState = advanceTurn(newState);
      }
      break;

    case 'use_witch':
      newState = executeWitch(newState, action.playerId, action.choice);
      break;

    case 'use_familiar':
      newState = executeFieldAction(newState, action.playerId, action.fieldId, action.details, true);
      newState.consecutivePasses = 0;
      if (!newState.extraCombatPlayerId) {
        newState = advanceTurn(newState);
      }
      break;

    case 'use_relic':
      newState = executeRelic(newState, action.playerId, action.relicId);
      break;

    case 'extra_combat': {
      // M67追加戦闘：フィールド枠・マナコスト不要、魔導具は通常通りタップ必要
      newState.extraCombatPlayerId = undefined;
      newState = executeCombat(newState, action.playerId, action.saintId, action.tappedToolIds, action.combatRelicIds || []);
      newState.consecutivePasses = 0;
      newState = advanceTurn(newState);
      break;
    }
  }

  // 全プレイヤーのパッシブ聖遺物VPを再計算
  newState = recalcAllPassiveVP(newState);

  return newState;
}

function executePass(state: MajoGameState, playerId: string): MajoGameState {
  let newState = updatePlayer(state, playerId, { passed: true });
  newState.consecutivePasses++;

  // 全員パスしたらラウンド終了
  if (newState.consecutivePasses >= newState.players.length) {
    return endRound(newState);
  }

  return advanceTurn(newState);
}

function executeFieldAction(
  state: MajoGameState,
  playerId: string,
  fieldId: FieldActionId,
  details: FieldActionDetails,
  useFamiliar: boolean,
): MajoGameState {
  let newState = { ...state };
  const player = getPlayer(newState, playerId);

  // 使い魔使用
  if (useFamiliar) {
    newState = updatePlayer(newState, playerId, { familiarTapped: true });
  }

  // フィールドの枠を消費（使い魔の場合も枠は消費しない＝既に埋まった枠に入る）
  if (!useFamiliar) {
    newState = updateField(newState, fieldId, {
      usedSlots: getField(newState, fieldId).usedSlots + 1,
    });
  }

  // パスフラグリセット（アクションを取ったので）
  newState = updatePlayer(newState, playerId, { passed: false });

  switch (details.action) {
    case 'research': {
      const tool = newState.toolSupply.find((t) => t.id === details.toolId);
      if (!tool) throw new Error(`魔導具 ${details.toolId} が売り場にない`);
      const reduction = calculateCostReduction(getPlayer(newState, playerId), []);
      const cost = Math.max(1, tool.cost - reduction);
      const p = getPlayer(newState, playerId);
      if (p.mana < cost) throw new Error(`マナが足りない（必要:${cost}, 所持:${p.mana}）`);

      newState = updatePlayer(newState, playerId, {
        mana: p.mana - cost,
        magicTools: [...p.magicTools, tool],
      });
      newState.toolSupply = newState.toolSupply.filter((t) => t.id !== details.toolId);

      // 即補充：デッキから1枚展示に追加
      if (newState.toolDeck.length > 0) {
        const replenished = newState.toolDeck[0];
        newState = {
          ...newState,
          toolSupply: [...newState.toolSupply, replenished],
          toolDeck: newState.toolDeck.slice(1),
          lastEvents: [...newState.lastEvents, `魔導具補充: ${replenished.name}(コスト${replenished.cost}, 魔力${replenished.magicPower}) が展示に追加されました`],
        };
      }
      break;
    }

    case 'violence':
    case 'sacrifice': {
      const manaCost = details.action === 'violence' ? 2 : 5;
      const p = getPlayer(newState, playerId);
      if (p.mana < manaCost) throw new Error(`マナが足りない`);

      newState = updatePlayer(newState, playerId, { mana: p.mana - manaCost });
      newState = executeCombat(newState, playerId, details.saintId, details.tappedToolIds, details.combatRelicIds || []);
      break;
    }

    case 'magic_shop': {
      const p = getPlayer(newState, playerId);
      if (p.mana < 1) throw new Error('マナが足りない');
      // コスト1はアンタップマナから支払い、報酬2はタップマナとして獲得
      newState = updatePlayer(newState, playerId, {
        mana: p.mana - 1,
        tappedMana: p.tappedMana + 2,
      });
      break;
    }

    case 'cathedral': {
      const p = getPlayer(newState, playerId);
      if (p.mana < 1) throw new Error('マナが足りない');
      // コスト1はアンタップマナから支払い、報酬1はタップマナとして獲得
      newState = updatePlayer(newState, playerId, {
        mana: p.mana - 1,
        tappedMana: p.tappedMana + 1,
      });

      // スタートプレイヤートークン移動
      const playerIndex = newState.players.findIndex((pp) => pp.config.id === playerId);
      newState.startPlayerIndex = playerIndex;

      // 聖遺物M55ボーナス：ラウンド中獲得なのでタップマナに追加
      const pUpdated = getPlayer(newState, playerId);
      if (pUpdated.relics.some((r) => r.id === 'M55')) {
        newState = updatePlayer(newState, playerId, { tappedMana: pUpdated.tappedMana + 1 });
      }
      break;
    }

    case 'prayer': {
      const p = getPlayer(newState, playerId);
      if (p.mana < 1) throw new Error('マナが足りない');
      const relic = p.relics.find((r) => r.id === details.relicId);
      if (!relic) throw new Error(`聖遺物 ${details.relicId} を持っていない`);

      // コスト1はアンタップマナから支払い、報酬3はタップマナとして獲得
      newState = updatePlayer(newState, playerId, {
        mana: p.mana - 1,
        tappedMana: p.tappedMana + 3,
        relics: p.relics.filter((r) => r.id !== details.relicId),
      });
      break;
    }
  }

  // M64聖遺物：この手番中のマナ支払い分を還元（タップマナとして）
  if (newState.manaRefundPlayerId === playerId) {
    const beforeMana = player.mana; // アクション前のマナ
    const afterPlayer = getPlayer(newState, playerId);
    const spent = beforeMana - afterPlayer.mana;
    if (spent > 0) {
      newState = updatePlayer(newState, playerId, {
        tappedMana: afterPlayer.tappedMana + spent,
      });
      newState = {
        ...newState,
        lastEvents: [...newState.lastEvents, `💎 M64効果：支払った${spent}マナがタップマナとして還元！`],
      };
    }
    // 手番終了後にフラグクリア（advanceTurnで次のプレイヤーに移るので）
    newState.manaRefundPlayerId = undefined;
  }

  return newState;
}

function executeCombat(
  state: MajoGameState,
  playerId: string,
  saintId: string,
  tappedToolIds: string[],
  combatRelicIds: string[] = [],
): MajoGameState {
  let newState = { ...state };
  const player = getPlayer(newState, playerId);
  const saint = newState.saintSupply.find((s) => s.id === saintId);
  if (!saint) throw new Error(`聖者 ${saintId} が展示にいない`);

  // 魔力計算（戦闘聖遺物のブーストを含む）
  const power = calculateCombatPower(player, tappedToolIds, combatRelicIds, false, newState.witchUsageCount);

  if (power < saint.hp) {
    throw new Error(`魔力不足（魔力:${power}, 聖者HP:${saint.hp}）`);
  }

  // 魔導具をタップ
  const newTappedIds = [...new Set([...player.tappedToolIds, ...tappedToolIds])];

  // 護符は戦闘で廃棄
  const usedAmulets = tappedToolIds
    .map((id) => player.magicTools.find((t) => t.id === id))
    .filter((t) => t && t.type === '護符' && t.effect.includes('戦闘：魔力＋3'));
  const amuletIds = usedAmulets.map((t) => t!.id);

  // 戦闘聖遺物のマナボーナス（M41/M42: 魔力+2, マナ+1）
  let combatRelicMana = 0;
  for (const relicId of combatRelicIds) {
    const relic = player.relics.find((r) => r.id === relicId);
    if (relic && relic.effect.includes('マナ＋1')) {
      combatRelicMana += 1;
    }
  }

  // 聖者撃破報酬（通常マナ報酬はタップ、即時マナはアンタップ）
  let tappedManaGain = saint.manaReward + combatRelicMana;
  let untappedManaGain = 0;

  // 魔剣・杖の効果
  for (const toolId of tappedToolIds) {
    const tool = player.magicTools.find((t) => t.id === toolId);
    if (tool && tool.effect.includes('聖者撃破：即時マナ＋1')) {
      untappedManaGain += 1; // 即時 = アンタップ
    } else if (tool && tool.effect.includes('聖者撃破：マナ＋1')) {
      tappedManaGain += 1; // 通常 = タップ
    }
    if (tool && tool.effect.includes('聖者撃破：即時マナ＋2')) {
      untappedManaGain += 2; // 即時 = アンタップ
    }
  }

  // 聖遺物を山札から引く（展示なし）
  const drawnRelics: MajoRelicCard[] = [];
  for (let i = 0; i < saint.relicDraw; i++) {
    if (newState.relicDeck.length > 0) {
      const drawnRelic = newState.relicDeck[0];
      drawnRelics.push(drawnRelic);
      newState = {
        ...newState,
        relicDeck: newState.relicDeck.slice(1),
        lastEvents: [...newState.lastEvents, `聖遺物獲得: ${drawnRelic.id}「${drawnRelic.effect}」`],
      };
    }
  }

  // 聖者展示の補充
  newState = {
    ...newState,
    saintSupply: newState.saintSupply.filter((s) => s.id !== saintId),
  };
  if (newState.saintDeck.length > 0) {
    const replenishedSaint = newState.saintDeck[0];
    newState = {
      ...newState,
      saintSupply: [...newState.saintSupply, replenishedSaint],
      saintDeck: newState.saintDeck.slice(1),
      lastEvents: [...newState.lastEvents, `聖者補充: ${replenishedSaint.name}(HP${replenishedSaint.hp}/★${replenishedSaint.victoryPoints}) が展示に追加されました`],
    };
  }

  // プレイヤー更新（戦闘聖遺物も廃棄）
  // 聖者撃破マナ報酬はラウンド中に獲得するのでタップマナとして追加
  const updatedPlayer = getPlayer(newState, playerId);
  const allDiscardedRelicIds = new Set(combatRelicIds);
  newState = updatePlayer(newState, playerId, {
    tappedToolIds: newTappedIds.filter((id) => !amuletIds.includes(id)),
    magicTools: updatedPlayer.magicTools.filter((t) => !amuletIds.includes(t.id)),
    saints: [...updatedPlayer.saints, saint],
    relics: [...updatedPlayer.relics.filter((r) => !allDiscardedRelicIds.has(r.id)), ...drawnRelics],
    mana: updatedPlayer.mana + untappedManaGain, // 即時マナはアンタップ
    tappedMana: updatedPlayer.tappedMana + tappedManaGain, // 通常報酬はタップ
    victoryPoints: updatedPlayer.victoryPoints + saint.victoryPoints,
  });

  // M67聖遺物：追加戦闘フラグ
  for (const relicId of combatRelicIds) {
    if (relicId === 'M67') {
      newState.extraCombatPlayerId = playerId;
      newState = {
        ...newState,
        lastEvents: [...newState.lastEvents, `⚔️ 聖遺物M67発動！追加戦闘が可能に`],
      };
    }
  }

  // 実績チェック
  newState = checkAchievements(newState, playerId, power);

  return newState;
}

function executeWitch(state: MajoGameState, playerId: string, choice: 'magic' | 'mana'): MajoGameState {
  const player = getPlayer(state, playerId);
  if (player.witchTapped) throw new Error('魔女は既に使用済み');

  const bonus = state.witchUsageCount; // 0, 1, 2, 3...

  let newState = {
    ...state,
    witchUsageCount: state.witchUsageCount + 1,
  };

  if (choice === 'mana') {
    // 魔女マナモード：ラウンド中の獲得なのでタップマナとして追加
    newState = updatePlayer(newState, playerId, {
      witchTapped: true,
      tappedMana: player.tappedMana + 2 + bonus,
    });
  } else {
    // 魔力モードは戦闘時に加算されるので、ここではフラグだけ
    // 実際には魔女の魔力は戦闘計算時に加算する
    // ただし、魔女をタップしただけで魔力が「貯まる」わけではない
    // → 戦闘時に「魔女をこの戦闘で使う」と宣言する形が正しい
    // 簡易実装：魔女タップ時に一時的に魔力ブーストをフラグとして持つ
    newState = updatePlayer(newState, playerId, {
      witchTapped: true,
    });
    // 注意: 魔力ブーストは calculateCombatPower で処理する
  }

  return newState;
}

function executeRelic(state: MajoGameState, playerId: string, relicId: string): MajoGameState {
  const player = getPlayer(state, playerId);
  const relic = player.relics.find((r) => r.id === relicId);
  if (!relic) throw new Error(`聖遺物 ${relicId} を持っていない`);

  let newState = { ...state };

  // 効果適用
  switch (relicId) {
    case 'M43':
    case 'M44': {
      // タップ済み魔導具をアンタップ
      newState = updatePlayer(newState, playerId, {
        tappedToolIds: [],
        relics: player.relics.filter((r) => r.id !== relicId),
      });
      break;
    }
    case 'M56':
    case 'M57':
    case 'M58':
    case 'M59': {
      // 手番：タップマナをアンタップする。廃棄
      // タップマナを全てアンタップマナに変換する
      newState = updatePlayer(newState, playerId, {
        mana: player.mana + player.tappedMana,
        tappedMana: 0,
        relics: player.relics.filter((r) => r.id !== relicId),
      });
      break;
    }
    case 'M52': {
      // 使い魔を未使用状態に
      newState = updatePlayer(newState, playerId, {
        familiarTapped: false,
        relics: player.relics.filter((r) => r.id !== relicId),
      });
      break;
    }
    case 'M53': {
      // 3コスト以下の魔導具をタダで獲得
      const freeTool = newState.toolSupply.find((t) => t.cost <= 3);
      if (freeTool) {
        newState = updatePlayer(newState, playerId, {
          magicTools: [...player.magicTools, freeTool],
          relics: player.relics.filter((r) => r.id !== relicId),
        });
        newState.toolSupply = newState.toolSupply.filter((t) => t.id !== freeTool.id);
      }
      break;
    }
    case 'M60': {
      // 追加の手番（簡易：ターン巻き戻し）
      newState = updatePlayer(newState, playerId, {
        relics: player.relics.filter((r) => r.id !== relicId),
      });
      // 次のadvanceTurnでこのプレイヤーのまま
      const idx = newState.players.findIndex((p) => p.config.id === playerId);
      newState.currentPlayerIndex = idx;
      break;
    }
    case 'M61': {
      // 魔導具所持数分のマナ：ラウンド中獲得なのでタップマナに追加
      newState = updatePlayer(newState, playerId, {
        tappedMana: player.tappedMana + player.magicTools.length,
        relics: player.relics.filter((r) => r.id !== relicId),
      });
      break;
    }
    case 'M62': {
      // 勝利点分のマナ：ラウンド中獲得なのでタップマナに追加
      newState = updatePlayer(newState, playerId, {
        tappedMana: player.tappedMana + player.victoryPoints,
        relics: player.relics.filter((r) => r.id !== relicId),
      });
      break;
    }
    case 'M63': {
      // 2アンタップマナを支払い、6タップマナを獲得
      if (player.mana >= 2) {
        newState = updatePlayer(newState, playerId, {
          mana: player.mana - 2,
          tappedMana: player.tappedMana + 6,
          relics: player.relics.filter((r) => r.id !== relicId),
        });
      }
      break;
    }
    case 'M64': {
      // 手番：この手番中にマナを支払うなら、同じ数のマナを獲得。廃棄
      newState = updatePlayer(newState, playerId, {
        relics: player.relics.filter((r) => r.id !== relicId),
      });
      newState.manaRefundPlayerId = playerId;
      newState = {
        ...newState,
        lastEvents: [...newState.lastEvents, `💎 聖遺物M64発動！この手番中のマナ支払いが全額還元される`],
      };
      break;
    }
    case 'M65': {
      // 手番：魔導具を1つ捨て、捨てた魔導具のコスト+3コストまでの魔導具を売り場から獲得。廃棄
      // コスト差が最大になる交換を探す（捨てる魔導具は自由に選べる）
      if (player.magicTools.length > 0 && newState.toolSupply.length > 0) {
        let bestExchange: { discard: MajoToolCard; gain: MajoToolCard; diff: number } | null = null;
        for (const ownTool of player.magicTools) {
          const maxCost = ownTool.cost + 3;
          const candidates = newState.toolSupply.filter((t) => t.cost <= maxCost);
          for (const candidate of candidates) {
            const diff = candidate.cost - ownTool.cost;
            if (!bestExchange || diff > bestExchange.diff) {
              bestExchange = { discard: ownTool, gain: candidate, diff };
            }
          }
        }
        if (bestExchange) {
          newState = updatePlayer(newState, playerId, {
            magicTools: [...player.magicTools.filter((t) => t.id !== bestExchange!.discard.id), bestExchange.gain],
            relics: player.relics.filter((r) => r.id !== relicId),
          });
          newState = {
            ...newState,
            toolSupply: newState.toolSupply.filter((t) => t.id !== bestExchange!.gain.id),
            lastEvents: [...newState.lastEvents, `🔄 聖遺物M65発動！${bestExchange.discard.name}(コスト${bestExchange.discard.cost})を捨てて${bestExchange.gain.name}(コスト${bestExchange.gain.cost})を獲得`],
          };
          // 魔導具補充
          if (newState.toolDeck.length > 0) {
            const replenished = newState.toolDeck[0];
            newState = {
              ...newState,
              toolSupply: [...newState.toolSupply, replenished],
              toolDeck: newState.toolDeck.slice(1),
              lastEvents: [...newState.lastEvents, `魔導具補充: ${replenished.name}(コスト${replenished.cost}, 魔力${replenished.magicPower}) が展示に追加されました`],
            };
          }
        }
      }
      break;
    }
    case 'M66': {
      // 聖者を1つ捨てて4マナ：ラウンド中獲得なのでタップマナに追加
      if (player.saints.length > 0) {
        const discardedSaint = player.saints[player.saints.length - 1]; // 最後の聖者を捨てる
        newState = updatePlayer(newState, playerId, {
          saints: player.saints.slice(0, -1),
          victoryPoints: player.victoryPoints - discardedSaint.victoryPoints,
          tappedMana: player.tappedMana + 4,
          relics: player.relics.filter((r) => r.id !== relicId),
        });
      }
      break;
    }
    default: {
      // 未実装の聖遺物は廃棄のみ
      newState = updatePlayer(newState, playerId, {
        relics: player.relics.filter((r) => r.id !== relicId),
      });
      break;
    }
  }

  return newState;
}

// ── 実績チェック ──

function checkAchievements(state: MajoGameState, playerId: string, combatPower: number = 0): MajoGameState {
  let newState = { ...state };
  const player = getPlayer(newState, playerId);

  for (const achievement of [...newState.achievements]) {
    let achieved = false;

    switch (achievement.id) {
      case 'M126': // 魔導具5つ以上
        achieved = player.magicTools.length >= 5;
        break;
      case 'M127': // 14以上の魔力で撃破
        achieved = combatPower >= 14;
        break;
      case 'M128': // 聖者5つ以上
        achieved = player.saints.length >= 5;
        break;
      case 'M129': { // 同種魔導具3つ以上
        const typeCounts: Record<string, number> = {};
        for (const tool of player.magicTools) {
          typeCounts[tool.type] = (typeCounts[tool.type] || 0) + 1;
        }
        achieved = Object.values(typeCounts).some((c) => c >= 3);
        break;
      }
      case 'M130': // 聖遺物5つ以上
        achieved = player.relics.length >= 5;
        break;
    }

    if (achieved) {
      newState = updatePlayer(newState, playerId, {
        victoryPoints: getPlayer(newState, playerId).victoryPoints + achievement.victoryPoints,
      });
      newState.achievements = newState.achievements.filter((a) => a.id !== achievement.id);
      newState = {
        ...newState,
        lastEvents: [...newState.lastEvents, `🏆 実績達成「${achievement.name}」★+${achievement.victoryPoints}！（${achievement.condition}）`],
      };
    }
  }

  return newState;
}

// ── パッシブ聖遺物によるVP計算（ゲーム終了時） ──

export function calculatePassiveRelicVP(player: MajoPlayerState): number {
  let vp = 0;

  for (const relic of player.relics) {
    if (relic.timing !== 'passive') continue;

    switch (relic.id) {
      case 'M45': // セラフィムかガブリエル所持
        if (player.saints.some((s) => s.name === 'セラフィム' || s.name === 'ガブリエル')) vp++;
        break;
      case 'M46': // ウリエルかメタトロン所持
        if (player.saints.some((s) => s.name === 'ウリエル' || s.name === 'メタトロン')) vp++;
        break;
      case 'M47': // ケルビムかアズラエル所持
        if (player.saints.some((s) => s.name === 'ケルビム' || s.name === 'アズラエル')) vp++;
        break;
      case 'M48': { // 魔導具4種類以上
        const types = new Set(player.magicTools.map((t) => t.type));
        if (types.size >= 4) vp++;
        break;
      }
      case 'M49': // 体力10の聖者所持
        if (player.saints.some((s) => s.hp === 10)) vp++;
        break;
      case 'M50': // 護符所持
        if (player.magicTools.some((t) => t.type === '護符')) vp++;
        break;
      case 'M51': // 勝利点0の聖者所持
        if (player.saints.some((s) => s.victoryPoints === 0)) vp++;
        break;
    }
  }

  return vp;
}

// パッシブ聖遺物VPの差分を全プレイヤーに適用
function recalcAllPassiveVP(state: MajoGameState): MajoGameState {
  let newState = { ...state };
  for (const player of newState.players) {
    const currentPassive = calculatePassiveRelicVP(player);
    const diff = currentPassive - player.lastPassiveVP;
    if (diff !== 0) {
      newState = updatePlayer(newState, player.config.id, {
        victoryPoints: player.victoryPoints + diff,
        lastPassiveVP: currentPassive,
      });
      if (diff > 0) {
        newState = {
          ...newState,
          lastEvents: [...newState.lastEvents, `🔮 ${player.config.name}: パッシブ聖遺物ボーナス ★+${diff}`],
        };
      }
    }
  }
  return newState;
}

// ── ターン/ラウンド管理 ──

function advanceTurn(state: MajoGameState): MajoGameState {
  // 勝利条件チェック
  if (state.players.some((p) => p.victoryPoints >= VICTORY_POINT_TARGET)) {
    // 誰かが5VPに到達 → ラウンド最後の人まで続ける
    // 最後の人 = startPlayerIndexの1つ前のプレイヤー
    const lastPlayerIndex = (state.startPlayerIndex - 1 + state.players.length) % state.players.length;
    if (state.currentPlayerIndex === lastPlayerIndex) {
      return endGame(state);
    }
  }

  const next = (state.currentPlayerIndex + 1) % state.players.length;
  return { ...state, currentPlayerIndex: next, manaRefundPlayerId: undefined };
}

function endRound(state: MajoGameState): MajoGameState {
  // 勝利条件チェック
  if (state.players.some((p) => p.victoryPoints >= VICTORY_POINT_TARGET)) {
    return endGame(state);
  }

  // フィールドリセット
  let newState: MajoGameState = {
    ...state,
    fieldActions: createFieldActions(),
    round: state.round + 1,
    consecutivePasses: 0,
    currentPlayerIndex: state.startPlayerIndex,
  };

  // 全プレイヤーの状態リセット
  newState = {
    ...newState,
    players: newState.players.map((p) => ({
      ...p,
      tappedToolIds: [],                       // 魔導具アンタップ
      passed: false,
      mana: p.mana + p.tappedMana + 1,         // タップマナをアンタップ + ラウンド開始ボーナス+1
      tappedMana: 0,                           // タップマナリセット
    })),
  };

  // M27 水晶玉は「いつでもアンタップ」なので実質的に上記で処理済み

  return newState;
}

function endGame(state: MajoGameState): MajoGameState {
  return { ...state, phase: 'finished' };
}

// ── 最終スコア ──

export function getMajoFinalScores(state: MajoGameState): MajoFinalScore[] {
  const scores: MajoFinalScore[] = state.players.map((p) => ({
    playerId: p.config.id,
    name: p.config.name,
    victoryPoints: p.victoryPoints,
    saints: p.saints.length,
    tools: p.magicTools.length,
    relics: p.relics.length,
    rank: 0,
  }));

  scores.sort((a, b) => b.victoryPoints - a.victoryPoints);

  let rank = 1;
  for (let i = 0; i < scores.length; i++) {
    if (i > 0 && scores[i].victoryPoints < scores[i - 1].victoryPoints) {
      rank = i + 1;
    }
    scores[i].rank = rank;
  }

  return scores;
}

export function isMajoGameOver(state: MajoGameState): boolean {
  return state.phase === 'finished';
}
