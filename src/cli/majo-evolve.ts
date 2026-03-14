// Codex note (2026-03-14): CLI flags below were added so Claude can rerun seeded/locked training batches. Benchmark flags were added to score candidates against beta.
// 魔女ゲー 遺伝的アルゴリズム 進化ランナ�E
// AI戦略パラメータを�E動進化させて最強の魔女AIを育てめE

import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  createMajoGame, getCurrentPlayer, isMajoGameOver,
  executeAction, getMajoFinalScores,
} from '../engine/majo.js';
import {
  createParameterizedStrategy,
  DEFAULT_PARAMS,
  randomizeParams,
  mutateParams,
  crossoverParams,
  type MajoParams,
} from '../ai/majo-params.js';
import { getMajoStrategy, getRandomMajoStrategy, majoStrategyIds } from '../ai/majo-strategies.js';
import type { PlayerConfig } from '../engine/types.js';
import type { MajoAIStrategy, MajoGameState, MajoFinalScore } from '../engine/majo-types.js';

// ── 定数 ──

const MAX_TURNS_PER_GAME = 300;  // 無限ループ防止
const SURVIVOR_RATIO = 0.3;       // 上佁E0%が生き残る
const CROSSOVER_RATIO = 0.4;      // 新世代の40%は交叉で生�E
const MUTATION_RATE = 0.2;        // 吁E��ラメータの突然変異確玁E

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');

// ── 型定義 ──

/** 個体！EつのパラメータセチE�� + 適応度�E�E*/
interface Individual {
  params: MajoParams;
  fitness: number;       // 平均VP
  games: number;         // プレイしたゲーム数
  wins: number;          // 1位�E回数
}

/** カード統訁E*/
interface CardStats {
  tools: Record<string, ToolStats>;
  saints: Record<string, SaintStats>;
  relics: Record<string, RelicStats>;
  strategies: Record<string, StrategyStats>;
  gameLength: { totalRounds: number; totalTurns: number; games: number };
  totalGames: number;
}

interface StrategyStats {
  id: string;
  games: number;
  totalVP: number;
  wins: number;
  totalTools: number;      // ゲーム終亁E��の魔道具数合訁E
  totalSaints: number;     // ゲーム終亁E��の聖老E��合訁E
  totalRelics: number;     // ゲーム終亁E��の聖遺物数合訁E
  totalMana: number;       // ゲーム終亁E��のマナ合訁E
}

interface ToolStats {
  id: string;
  name: string;
  timesBought: number;           // 購入された回数
  totalVPWhenOwned: number;      // 所有した時の総VP
  gamesWhenOwned: number;        // 所有したゲーム数�E�平均VP計算用�E�E
  totalVPWhenNotOwned: number;   // 所有しなかった時の総VP
  gamesWhenNotOwned: number;     // 所有しなかったゲーム数
  totalAcquireRound: number;     // 取得ラウンド�E合計（平坁E��算用�E�E
  acquireCount: number;          // 取得回数�E�Eree_tool含む�E�E
}

interface SaintStats {
  id: string;
  name: string;
  hp: number;
  vp: number;
  timesKilled: number;           // 撁E��された回数
  killedByStrategy: Record<string, number>; // 戦略別撁E��回数
  totalVPWhenOwned: number;      // 所有した時の総VP
  gamesWhenOwned: number;        // 所有したゲーム数
  totalVPWhenNotOwned: number;   // 所有しなかった時の総VP
  gamesWhenNotOwned: number;     // 所有しなかったゲーム数
}

interface RelicStats {
  id: string;
  timesObtained: number;         // 獲得された回数
  timesUsed: number;             // 使用された回数�E�Ese_relicアクション�E�E
  totalVPWhenOwned: number;      // 所有した時の総VP
  gamesWhenOwned: number;
}

// ── ゲーム実衁E──

/**
 * 1ゲームを実行して結果を返す
 * @param evolvedParams 進化中の個体�Eパラメータ�E�E人のプレイヤーに使用�E�E
 * @param gamesAgainstRandomOpponents 残りプレイヤーにランダム戦略を使用
 */
// Codex note (2026-03-14): benchmark-aware evaluation helpers were added to score candidates against beta, not just random baselines.
interface SingleGameOptions {
  playerCount?: number;
  benchmarkParams?: MajoParams | null;
  benchmarkName?: string;
  /** Coevolution: params from previous gen's best or random population members */
  coevolutionOpponents?: MajoParams[];
}

interface EvaluationConfig {
  benchmarkParams: MajoParams | null;
  benchmarkName: string;
  benchmarkWeight: number;
  benchmarkMarginWeight: number;
}

const BASELINE_STRATEGY_IDS = majoStrategyIds.filter((id) => id !== 'majo_evolved');

function pickRandomBaselineStrategy(): MajoAIStrategy {
  const ids = BASELINE_STRATEGY_IDS.length > 0 ? BASELINE_STRATEGY_IDS : majoStrategyIds;
  const id = ids[Math.floor(Math.random() * ids.length)];
  return getMajoStrategy(id);
}

async function runSingleGame(
  evolvedParams: MajoParams,
  options: SingleGameOptions = {},
): Promise<{
  scores: MajoFinalScore[];
  finalState: MajoGameState;
  evolvedPlayerIndex: number;
  benchmarkPlayerId: string | null;
}> {
  const {
    playerCount = 4,
    benchmarkParams = null,
    benchmarkName = 'benchmark',
    coevolutionOpponents = [],
  } = options;
  const evolvedPlayerIndex = Math.floor(Math.random() * playerCount);
  const evolvedStrategy = createParameterizedStrategy(evolvedParams);

  let benchmarkPlayerIndex = -1;
  let benchmarkStrategy: MajoAIStrategy | null = null;
  if (benchmarkParams) {
    benchmarkStrategy = createParameterizedStrategy(benchmarkParams);
    do {
      benchmarkPlayerIndex = Math.floor(Math.random() * playerCount);
    } while (benchmarkPlayerIndex === evolvedPlayerIndex);
  }

  // Coevolution: 70% of opponent slots use evolved opponents, 30% use fixed strategies
  // 純粋自己対戦はメタが閉じる。固定戦略混合で汎化能力を維持
  const coevoSlots = new Set<number>();
  if (coevolutionOpponents.length > 0) {
    for (let i = 0; i < playerCount; i++) {
      if (i === evolvedPlayerIndex) continue;
      if (i === benchmarkPlayerIndex) continue;
      if (Math.random() < 0.7) coevoSlots.add(i);
    }
  }

  const players: PlayerConfig[] = [];
  const strategies: MajoAIStrategy[] = [];

  for (let i = 0; i < playerCount; i++) {
    if (i === evolvedPlayerIndex) {
      players.push({
        id: `p${i}`,
        name: 'Candidate',
        type: 'ai' as const,
        strategyId: 'majo_candidate',
      });
      strategies.push(evolvedStrategy);
      continue;
    }

    if (i === benchmarkPlayerIndex && benchmarkStrategy) {
      players.push({
        id: `p${i}`,
        name: `Benchmark ${benchmarkName}`,
        type: 'ai' as const,
        strategyId: `benchmark_${benchmarkName}`,
      });
      strategies.push(benchmarkStrategy);
      continue;
    }

    // Coevolution: use an evolved opponent for this slot
    if (coevoSlots.has(i)) {
      const coevoParams = coevolutionOpponents[
        Math.floor(Math.random() * coevolutionOpponents.length)
      ];
      const coevoStrategy = createParameterizedStrategy(coevoParams);
      players.push({
        id: `p${i}`,
        name: 'CoevoOpponent',
        type: 'ai' as const,
        strategyId: 'majo_coevo',
      });
      strategies.push(coevoStrategy);
      continue;
    }

    const opponentStrategy = pickRandomBaselineStrategy();
    players.push({
      id: `p${i}`,
      name: opponentStrategy.name,
      type: 'ai' as const,
      strategyId: opponentStrategy.id,
    });
    strategies.push(opponentStrategy);
  }

  let state = await createMajoGame(players);
  let turnCount = 0;

  while (!isMajoGameOver(state) && turnCount < MAX_TURNS_PER_GAME) {
    const current = getCurrentPlayer(state);
    const playerIdx = state.players.findIndex((p) => p.config.id === current.config.id);
    const strategy = strategies[playerIdx];

    try {
      const { action } = strategy.selectAction(state, current.config.id);
      state = executeAction(state, action);
    } catch {
      try {
        state = executeAction(state, { type: 'pass', playerId: current.config.id });
      } catch {
        break;
      }
    }

    turnCount++;
  }

  const scores = getMajoFinalScores(state);
  return {
    scores,
    finalState: state,
    evolvedPlayerIndex,
    benchmarkPlayerId: benchmarkPlayerIndex >= 0 ? `p${benchmarkPlayerIndex}` : null,
  };
}

/**
 * 個体�E適応度を計算（褁E��ゲームの平均VP�E�E
 */
async function evaluateIndividual(
  individual: Individual,
  gamesPerEval: number,
  cardStats: CardStats,
  evaluationConfig: EvaluationConfig,
  coevolutionOpponents: MajoParams[] = [],
): Promise<Individual> {
  let totalVP = 0;
  let wins = 0;
  let benchmarkBeats = 0;
  let benchmarkMarginTotal = 0;
  let benchmarkGames = 0;

  for (let g = 0; g < gamesPerEval; g++) {
    const { scores, finalState, evolvedPlayerIndex, benchmarkPlayerId } = await runSingleGame(
      individual.params,
      {
        benchmarkParams: evaluationConfig.benchmarkParams,
        benchmarkName: evaluationConfig.benchmarkName,
        coevolutionOpponents,
      },
    );
    const evolvedPlayerId = `p${evolvedPlayerIndex}`;
    const evolvedScore = scores.find((s) => s.playerId === evolvedPlayerId);

    if (evolvedScore) {
      totalVP += evolvedScore.victoryPoints;
      if (evolvedScore.rank === 1) wins++;
    }

    if (evolvedScore && benchmarkPlayerId) {
      const benchmarkScore = scores.find((s) => s.playerId === benchmarkPlayerId);
      if (benchmarkScore) {
        const margin = evolvedScore.victoryPoints - benchmarkScore.victoryPoints;
        benchmarkGames++;
        benchmarkMarginTotal += margin;
        if (margin > 0) benchmarkBeats++;
      }
    }

    updateCardStats(cardStats, finalState, scores, evolvedPlayerId);
  }

  const averageVP = totalVP / gamesPerEval;
  const benchmarkBeatRate = benchmarkGames > 0 ? benchmarkBeats / benchmarkGames : 0;
  const benchmarkMargin = benchmarkGames > 0 ? benchmarkMarginTotal / benchmarkGames : 0;
  const fitness = averageVP
    + benchmarkBeatRate * evaluationConfig.benchmarkWeight
    + benchmarkMargin * evaluationConfig.benchmarkMarginWeight;

  return {
    ...individual,
    fitness,
    games: individual.games + gamesPerEval,
    wins: individual.wins + wins,
  };
}

// ── カード統訁E──

interface SeedParamsFile {
  generation?: number;
  fitness?: number;
  params: MajoParams;
  savedAt?: string;
}
function initCardStats(): CardStats {
  return {
    tools: {},
    saints: {},
    relics: {},
    strategies: {},
    gameLength: { totalRounds: 0, totalTurns: 0, games: 0 },
    totalGames: 0,
  };
}

function updateCardStats(
  stats: CardStats,
  finalState: MajoGameState,
  scores: MajoFinalScore[],
  _evolvedPlayerId: string,
): void {
  stats.totalGames++;

  // ゲーム長統訁E
  stats.gameLength.totalRounds += finalState.round;
  stats.gameLength.totalTurns += finalState.history.length;
  stats.gameLength.games++;

  // 全プレイヤーの最終状態からカード統計を更新
  for (const player of finalState.players) {
    const scoreEntry = scores.find((s) => s.playerId === player.config.id);
    const playerVP = scoreEntry?.victoryPoints ?? 0;
    const strategyId = player.config.strategyId ?? 'unknown';

    // 魔導�E統訁E
    const ownedToolIds = new Set(player.magicTools.map((t) => t.id));
    for (const tool of finalState.toolDeck.concat(finalState.toolSupply)) {
      const id = tool.id;
      if (!stats.tools[id]) {
        stats.tools[id] = {
          id,
          name: tool.name,
          timesBought: 0,
          totalVPWhenOwned: 0,
          gamesWhenOwned: 0,
          totalVPWhenNotOwned: 0,
          gamesWhenNotOwned: 0,
          totalAcquireRound: 0,
          acquireCount: 0,
        };
      }
    }
    for (const tool of player.magicTools) {
      if (!stats.tools[tool.id]) {
        stats.tools[tool.id] = {
          id: tool.id,
          name: tool.name,
          timesBought: 0,
          totalVPWhenOwned: 0,
          gamesWhenOwned: 0,
          totalVPWhenNotOwned: 0,
          gamesWhenNotOwned: 0,
          totalAcquireRound: 0,
          acquireCount: 0,
        };
      }
      stats.tools[tool.id].timesBought++;
      stats.tools[tool.id].totalVPWhenOwned += playerVP;
      stats.tools[tool.id].gamesWhenOwned++;
    }

    // 未所持E��導�Eの記録
    for (const toolId of Object.keys(stats.tools)) {
      if (!ownedToolIds.has(toolId)) {
        stats.tools[toolId].totalVPWhenNotOwned += playerVP;
        stats.tools[toolId].gamesWhenNotOwned++;
      }
    }

    // 聖老E��計（このプレイヤーが獲得した聖老E��E
    const ownedSaintIds = new Set(player.saints.map((s) => s.id));
    for (const saint of player.saints) {
      if (!stats.saints[saint.id]) {
        stats.saints[saint.id] = {
          id: saint.id,
          name: saint.name,
          hp: saint.hp,
          vp: saint.victoryPoints,
          timesKilled: 0,
          killedByStrategy: {},
          totalVPWhenOwned: 0,
          gamesWhenOwned: 0,
          totalVPWhenNotOwned: 0,
          gamesWhenNotOwned: 0,
        };
      }
      stats.saints[saint.id].timesKilled++;
      stats.saints[saint.id].totalVPWhenOwned += playerVP;
      stats.saints[saint.id].gamesWhenOwned++;
      const sk = stats.saints[saint.id].killedByStrategy;
      sk[strategyId] = (sk[strategyId] ?? 0) + 1;
    }

    // 未所持聖老E�E記録�E�聖老E��チE��・展示にぁE��聖老E+ 他�Eレイヤーが持つ聖老E��含む全聖老E��E
    for (const saintId of Object.keys(stats.saints)) {
      if (!ownedSaintIds.has(saintId)) {
        stats.saints[saintId].totalVPWhenNotOwned += playerVP;
        stats.saints[saintId].gamesWhenNotOwned++;
      }
    }

    // 聖老E��チE��・展示の聖老E��stats初期化（�E聖老E��記録されるよぁE���E�E
    for (const saint of [...finalState.saintDeck, ...finalState.saintSupply]) {
      if (!stats.saints[saint.id]) {
        stats.saints[saint.id] = {
          id: saint.id,
          name: saint.name,
          hp: saint.hp,
          vp: saint.victoryPoints,
          timesKilled: 0,
          killedByStrategy: {},
          totalVPWhenOwned: 0,
          gamesWhenOwned: 0,
          totalVPWhenNotOwned: 0,
          gamesWhenNotOwned: 0,
        };
      }
    }

    // 聖遺物統訁E
    for (const relic of player.relics) {
      if (!stats.relics[relic.id]) {
        stats.relics[relic.id] = {
          id: relic.id,
          timesObtained: 0,
          timesUsed: 0,
          totalVPWhenOwned: 0,
          gamesWhenOwned: 0,
        };
      }
      stats.relics[relic.id].timesObtained++;
      stats.relics[relic.id].totalVPWhenOwned += playerVP;
      stats.relics[relic.id].gamesWhenOwned++;
    }

    // 戦略統訁E
    if (!stats.strategies[strategyId]) {
      stats.strategies[strategyId] = {
        id: strategyId,
        games: 0,
        totalVP: 0,
        wins: 0,
        totalTools: 0,
        totalSaints: 0,
        totalRelics: 0,
        totalMana: 0,
      };
    }
    const ss = stats.strategies[strategyId];
    ss.games++;
    ss.totalVP += playerVP;
    if (scoreEntry?.rank === 1) ss.wins++;
    ss.totalTools += player.magicTools.length;
    ss.totalSaints += player.saints.length;
    ss.totalRelics += player.relics.length;
    ss.totalMana += player.mana + player.tappedMana;
  }

  // use_relicアクションの使用回数をカウンチE+ 魔道具取得ラウンド追跡
  let currentRound = 1;
  for (const action of finalState.history) {
    if (action.type === 'round_end') {
      currentRound++;
    } else if (action.type === 'use_relic') {
      const relicId = action.relicId;
      if (stats.relics[relicId]) {
        stats.relics[relicId].timesUsed++;
      }
    } else if (
      (action.type === 'field_action' || action.type === 'use_familiar') &&
      action.details.action === 'research'
    ) {
      const toolId = action.details.toolId;
      if (stats.tools[toolId]) {
        stats.tools[toolId].totalAcquireRound += currentRound;
        stats.tools[toolId].acquireCount++;
      }
    } else if (action.type === 'select_free_tool') {
      const toolId = action.toolId;
      if (stats.tools[toolId]) {
        stats.tools[toolId].totalAcquireRound += currentRound;
        stats.tools[toolId].acquireCount++;
      }
    }
  }
}

// ── ファイル保孁E──

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function saveEvolvedParams(params: MajoParams, generation: number, fitness: number, nameSuffix: string = ''): void {
  ensureDataDir();
  const data = {
    generation,
    fitness,
    params,
    savedAt: new Date().toISOString(),
  };
  const fileName = nameSuffix ? `evolved-params-${nameSuffix}.json` : 'evolved-params.json';
  fs.writeFileSync(
    path.join(DATA_DIR, fileName),
    JSON.stringify(data, null, 2),
    'utf-8',
  );
}

function saveCardStats(stats: CardStats, nameSuffix: string = ''): void {
  ensureDataDir();

  // 勝率相関を計算して追加
  const enrichedTools = Object.entries(stats.tools).map(([id, t]) => ({
    ...t,
    avgVPWhenOwned: t.gamesWhenOwned > 0 ? t.totalVPWhenOwned / t.gamesWhenOwned : 0,
    avgVPWhenNotOwned: t.gamesWhenNotOwned > 0 ? t.totalVPWhenNotOwned / t.gamesWhenNotOwned : 0,
    winCorrelation: t.gamesWhenOwned > 0 && t.gamesWhenNotOwned > 0
      ? (t.totalVPWhenOwned / t.gamesWhenOwned) - (t.totalVPWhenNotOwned / t.gamesWhenNotOwned)
      : 0,
    avgAcquireRound: t.acquireCount > 0 ? t.totalAcquireRound / t.acquireCount : 0,
  })).sort((a, b) => b.winCorrelation - a.winCorrelation);

  const enrichedRelics = Object.entries(stats.relics).map(([id, r]) => ({
    ...r,
    avgVPWhenOwned: r.gamesWhenOwned > 0 ? r.totalVPWhenOwned / r.gamesWhenOwned : 0,
    useRate: r.timesObtained > 0 ? r.timesUsed / r.timesObtained : 0,
  })).sort((a, b) => b.avgVPWhenOwned - a.avgVPWhenOwned);

  const enrichedSaints = Object.entries(stats.saints).map(([id, s]) => ({
    ...s,
    avgVPWhenOwned: s.gamesWhenOwned > 0 ? s.totalVPWhenOwned / s.gamesWhenOwned : 0,
    avgVPWhenNotOwned: s.gamesWhenNotOwned > 0 ? s.totalVPWhenNotOwned / s.gamesWhenNotOwned : 0,
    winCorrelation: s.gamesWhenOwned > 0 && s.gamesWhenNotOwned > 0
      ? (s.totalVPWhenOwned / s.gamesWhenOwned) - (s.totalVPWhenNotOwned / s.gamesWhenNotOwned)
      : 0,
  })).sort((a, b) => b.winCorrelation - a.winCorrelation);

  const enrichedStrategies = Object.values(stats.strategies).map((s) => ({
    ...s,
    avgVP: s.games > 0 ? s.totalVP / s.games : 0,
    winRate: s.games > 0 ? s.wins / s.games : 0,
    avgTools: s.games > 0 ? s.totalTools / s.games : 0,
    avgSaints: s.games > 0 ? s.totalSaints / s.games : 0,
    avgRelics: s.games > 0 ? s.totalRelics / s.games : 0,
    avgMana: s.games > 0 ? s.totalMana / s.games : 0,
  })).sort((a, b) => b.avgVP - a.avgVP);

  const output = {
    totalGames: stats.totalGames,
    avgRounds: stats.gameLength.games > 0 ? stats.gameLength.totalRounds / stats.gameLength.games : 0,
    avgTurns: stats.gameLength.games > 0 ? stats.gameLength.totalTurns / stats.gameLength.games : 0,
    tools: enrichedTools,
    saints: enrichedSaints,
    relics: enrichedRelics,
    strategies: enrichedStrategies,
    savedAt: new Date().toISOString(),
  };

  const fileName = nameSuffix ? `card-stats-${nameSuffix}.json` : 'card-stats.json';
  fs.writeFileSync(
    path.join(DATA_DIR, fileName),
    JSON.stringify(output, null, 2),
    'utf-8',
  );
}

// ── 表示ヘルパ�E ──

function formatParams(params: MajoParams): string {
  return [
    `VP釁E{params.saintVPWeight.toFixed(2)}`,
    `聖遺物釁E{params.saintRelicWeight.toFixed(2)}`,
    `0VP釁E{params.saintZeroVPWeight.toFixed(2)}`,
    `魔導�Emax${params.toolBuyMaxCount.toFixed(1)}`,
    `魔女R${params.witchRoundThreshold.toFixed(1)}`,
    `戦闘優允E{params.combatBeforePurchase.toFixed(2)}`,
    `聖遺物積極${params.relicAggressiveness.toFixed(2)}`,
    `実績聁E{params.achievementRelicWeight.toFixed(2)}`,
  ].join(' | ');
}

function printGenerationStats(
  generation: number,
  population: Individual[],
  elapsed: number,
): void {
  const sorted = [...population].sort((a, b) => b.fitness - a.fitness);
  const best = sorted[0];
  const avgFitness = population.reduce((s, i) => s + i.fitness, 0) / population.length;
  const worstFitness = sorted[sorted.length - 1].fitness;

  console.log(chalk.bold.yellow(`\n╔═╁E世代 ${String(generation).padStart(3)} ══════════════════════════════╗`));
  console.log(chalk.green(`  最高適応度: ${chalk.bold(best.fitness.toFixed(3))} VP  勝率: ${((best.wins / Math.max(best.games, 1)) * 100).toFixed(1)}%`));
  console.log(chalk.cyan( `  平坁E��応度: ${avgFitness.toFixed(3)} VP`));
  console.log(chalk.gray( `  最低適応度: ${worstFitness.toFixed(3)} VP`));
  console.log(chalk.gray( `  経過時間:   ${(elapsed / 1000).toFixed(1)}秒`));
  console.log(chalk.bold( `  最優秀パラメータ:`));
  console.log(chalk.cyan( `    ${formatParams(best.params)}`));
  console.log(chalk.bold.yellow(`╚══════════════════════════════════════════╝`));
}

function printProgress(current: number, total: number, label: string): void {
  const pct = Math.floor((current / total) * 100);
  const barLen = 30;
  const filled = Math.floor((current / total) * barLen);
  const bar = chalk.green('#'.repeat(filled)) + chalk.gray('-'.repeat(barLen - filled));
  process.stdout.write(`\r  ${label} [${bar}] ${pct}% (${current}/${total})`);
}

// ── 遺伝的アルゴリズム メインルーチE──

// Codex note (2026-03-14): added seed-name/lock helpers for local evolution experiments.
function loadSeedParams(seedName: string): SeedParamsFile {
  const fileName = seedName.endsWith('.json')
    ? seedName
    : `evolved-params-${seedName}.json`;
  const filePath = path.isAbsolute(fileName)
    ? fileName
    : path.join(DATA_DIR, fileName);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Seed params file not found: ${filePath}`);
  }

  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SeedParamsFile;
  if (!data.params) {
    throw new Error(`Seed params file is missing params: ${filePath}`);
  }
  // 新パラメータが欠落している場合はデフォルト値で補完
  data.params = { ...DEFAULT_PARAMS, ...data.params };
  return data;
}

function parseLockedKeys(lockArg: string): (keyof MajoParams)[] {
  if (!lockArg.trim()) return [];

  const validKeys = new Set<keyof MajoParams>(
    Object.keys(DEFAULT_PARAMS) as (keyof MajoParams)[]
  );
  const keys = lockArg
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as (keyof MajoParams)[];

  const invalid = keys.filter((key) => !validKeys.has(key));
  if (invalid.length > 0) {
    throw new Error(`Unknown lock params: ${invalid.join(', ')}`);
  }

  return [...new Set(keys)];
}

function applyLockedParams(
  params: MajoParams,
  baseParams: MajoParams,
  lockedKeys: (keyof MajoParams)[]
): MajoParams {
  if (lockedKeys.length === 0) return params;

  const result = { ...params };
  for (const key of lockedKeys) {
    result[key] = baseParams[key];
  }
  return result;
}
async function runEvolution(options: {
  generations: number;
  population: number;
  games: number;
  verbose: boolean;
  name: string;
  seedName: string;
  lock: string;
  benchmarkName: string;
  benchmarkWeight: number;
  benchmarkMarginWeight: number;
}): Promise<void> {
  const {
    generations,
    population: popSize,
    games: gamesPerEval,
    verbose,
    name: nameSuffix,
    seedName,
    lock,
    benchmarkName,
    benchmarkWeight,
    benchmarkMarginWeight,
  } = options;
  const lockedKeys = parseLockedKeys(lock);
  const seedData = seedName ? loadSeedParams(seedName) : null;
  const benchmarkData = benchmarkName ? loadSeedParams(benchmarkName) : null;
  const baseParams = seedData?.params ?? DEFAULT_PARAMS;
  const evaluationConfig: EvaluationConfig = {
    benchmarkParams: benchmarkData?.params ?? null,
    benchmarkName,
    benchmarkWeight,
    benchmarkMarginWeight,
  };
  console.log(chalk.bold('========================================'));
  console.log(chalk.bold('  Majo AI Evolution'));
  console.log(chalk.bold('========================================'));
  if (benchmarkData) {
    console.log(chalk.gray(`  Benchmark: ${benchmarkName} (weight ${benchmarkWeight.toFixed(2)}, margin ${benchmarkMarginWeight.toFixed(2)})`));
  }
  console.log(chalk.cyan(`  Generations: ${generations}  Population: ${popSize}  Games/Eval: ${gamesPerEval}`));
  console.log(chalk.gray(`  Survivor: ${(SURVIVOR_RATIO * 100).toFixed(0)}%  Crossover: ${(CROSSOVER_RATIO * 100).toFixed(0)}%  Mutation: ${(MUTATION_RATE * 100).toFixed(0)}%`));
  if (seedData) {
    const seedFitness = typeof seedData.fitness === 'number' ? seedData.fitness.toFixed(3) : '-';
    console.log(chalk.gray(`  Seed: ${seedName} (gen ${seedData.generation ?? '-'}, fitness ${seedFitness})`));
  }
  if (lockedKeys.length > 0) {
    console.log(chalk.gray(`  Locked params: ${lockedKeys.join(', ')}`));
  }
  console.log('');

  // ── 初期雁E��の生�E ──
  console.log(chalk.bold('初期雁E��を生成中...'));

  const cardStats = initCardStats();
  let individuals: Individual[] = [
    { params: applyLockedParams(baseParams, baseParams, lockedKeys), fitness: 0, games: 0, wins: 0 },
    ...Array.from({ length: popSize - 1 }, (_, idx) => ({
      params: applyLockedParams(
        seedData && idx < Math.ceil((popSize - 1) * 0.75)
          ? mutateParams(baseParams, 0.6)
          : randomizeParams(),
        baseParams,
        lockedKeys,
      ),
      fitness: 0,
      games: 0,
      wins: 0,
    })),
  ];
  for (let i = 0; i < individuals.length; i++) {
    printProgress(i + 1, individuals.length, '評価');
    individuals[i] = await evaluateIndividual(individuals[i], gamesPerEval, cardStats, evaluationConfig);
  }
  console.log('');

  // 初期世代の表示
  printGenerationStats(0, individuals, 0);
  saveCardStats(cardStats, nameSuffix);

  let allTimeBest: Individual = individuals.sort((a, b) => b.fitness - a.fitness)[0];
  // Coevolution: track previous generation's best for self-play
  let prevGenBestParams: MajoParams | null = null;

  // ── 進化ルーチE──
  for (let gen = 1; gen <= generations; gen++) {
    const genStart = Date.now();

    // ソートして適応度頁E��並べめE
    individuals.sort((a, b) => b.fitness - a.fitness);

    // 上位を生存老E��して保持
    const survivorCount = Math.max(2, Math.floor(popSize * SURVIVOR_RATIO));
    const survivors = individuals.slice(0, survivorCount);

    // 新世代の生�E
    const newGeneration: Individual[] = [...survivors];

    const crossoverCount = Math.floor(popSize * CROSSOVER_RATIO);
    const mutationCount = popSize - survivorCount - crossoverCount;

    // 交叉による子供生戁E
    for (let i = 0; i < crossoverCount; i++) {
      const parentA = survivors[Math.floor(Math.random() * survivors.length)];
      const parentB = survivors[Math.floor(Math.random() * survivors.length)];
      const childParams = applyLockedParams(
        mutateParams(crossoverParams(parentA.params, parentB.params), MUTATION_RATE * 0.5),
        baseParams,
        lockedKeys,
      );
      newGeneration.push({ params: childParams, fitness: 0, games: 0, wins: 0 });
    }

    // 突然変異による子供生戁E
    for (let i = 0; i < mutationCount; i++) {
      const parent = survivors[Math.floor(Math.random() * survivors.length)];
      const childParams = applyLockedParams(
        mutateParams(parent.params, MUTATION_RATE),
        baseParams,
        lockedKeys,
      );
      newGeneration.push({ params: childParams, fitness: 0, games: 0, wins: 0 });
    }

    // Coevolution: build opponent pool from previous gen's best + random survivors
    const coevolutionOpponents: MajoParams[] = [];
    if (prevGenBestParams) {
      coevolutionOpponents.push(prevGenBestParams);
    }
    // Add a few random survivors as additional coevolution opponents
    const coevoSurvivorCount = Math.min(2, survivors.length);
    for (let ci = 0; ci < coevoSurvivorCount; ci++) {
      const randomSurvivor = survivors[Math.floor(Math.random() * survivors.length)];
      coevolutionOpponents.push(randomSurvivor.params);
    }

    // 全個体を評価（生存者も再評価して運の偏りを排除）
    if (verbose) {
      console.log(chalk.bold(`\n世代 ${gen}: 全${newGeneration.length}体を評価中... (coevo opponents: ${coevolutionOpponents.length})`));
    }

    for (let i = 0; i < newGeneration.length; i++) {
      if (verbose) printProgress(i + 1, newGeneration.length, '全個体評価');
      newGeneration[i] = await evaluateIndividual(
        { ...newGeneration[i], fitness: 0, games: 0, wins: 0 },
        gamesPerEval,
        cardStats,
        evaluationConfig,
        coevolutionOpponents,
      );
    }
    if (verbose) console.log('');

    individuals = newGeneration;

    const elapsed = Date.now() - genStart;
    printGenerationStats(gen, individuals, elapsed);

    // 最優秀個体の更新
    const genBest = individuals.sort((a, b) => b.fitness - a.fitness)[0];
    // Coevolution: remember this generation's best for next gen's opponent pool
    prevGenBestParams = { ...genBest.params };
    if (genBest.fitness > allTimeBest.fitness) {
      allTimeBest = genBest;
      console.log(chalk.bold.green(`  新記録�E�E適応度 ${genBest.fitness.toFixed(3)} VP`));
      saveEvolvedParams(genBest.params, gen, genBest.fitness, nameSuffix);
    }

    // カード統計を毎世代保孁E
    saveCardStats(cardStats, nameSuffix);
  }
  console.log(chalk.bold.yellow('========================================'));
  console.log(chalk.bold.yellow('             Evolution Result             '));
  console.log(chalk.bold.yellow('========================================'));
  console.log(chalk.bold.yellow('========================================'));
  console.log(chalk.bold.yellow('             Evolution Result             '));
  console.log(chalk.bold.yellow('========================================'));
  console.log(chalk.green(`\nBest overall params (fitness: ${allTimeBest.fitness.toFixed(3)} VP):`));
  const params = allTimeBest.params;
  const paramEntries = Object.entries(params) as [keyof MajoParams, number][];
  for (const [key, val] of paramEntries) {
    const defaultVal = DEFAULT_PARAMS[key];
    const diff = val - defaultVal;
    const diffStr = diff >= 0
      ? chalk.green(`+${diff.toFixed(3)}`)
      : chalk.red(`${diff.toFixed(3)}`);
    console.log(`  ${chalk.bold(key.padEnd(25))}: ${val.toFixed(3).padStart(8)}  (チE��ォルト毁E${diffStr})`);
  }

  const paramFile = nameSuffix ? `evolved-params-${nameSuffix}.json` : 'evolved-params.json';
  const statsFile = nameSuffix ? `card-stats-${nameSuffix}.json` : 'card-stats.json';
  console.log(chalk.gray(`\n  保存�E: ${path.join(DATA_DIR, paramFile)}`));
  console.log(chalk.gray(`  カード統訁E ${path.join(DATA_DIR, statsFile)}`));
  console.log(chalk.bold('========================================'));
  console.log(chalk.bold('========================================'));
  console.log(chalk.bold('  Card stats summary'));
  console.log(chalk.bold(`  Total evaluated games: ${cardStats.totalGames}`));
  console.log(chalk.bold('========================================'));
  console.log(chalk.bold(`  Total evaluated games: ${cardStats.totalGames}`));
  const topTools = Object.values(cardStats.tools)
    .filter((t) => t.gamesWhenOwned >= 5)
    .map((t) => ({
      ...t,
      winCorr: t.gamesWhenOwned > 0 && t.gamesWhenNotOwned > 0
        ? (t.totalVPWhenOwned / t.gamesWhenOwned) - (t.totalVPWhenNotOwned / t.gamesWhenNotOwned)
        : 0,
    }))
    .sort((a, b) => b.winCorr - a.winCorr)
    .slice(0, 5);

  if (topTools.length > 0) {
    console.log(chalk.bold('\n  魔導�E 勝利貢献度 TOP5:'));
    for (const t of topTools) {
      const corrStr = t.winCorr >= 0
        ? chalk.green(`+${t.winCorr.toFixed(2)}`)
        : chalk.red(`${t.winCorr.toFixed(2)}`);
      console.log(`    ${t.name.padEnd(12)} 購入${String(t.timesBought).padStart(4)}囁E 所持時平均VP: ${(t.totalVPWhenOwned / t.gamesWhenOwned).toFixed(2)}  差: ${corrStr}`);
    }
  }

  // 聖老E��ンキング�E�撃破回数頁E��E
  const topSaints = Object.values(cardStats.saints)
    .sort((a, b) => b.timesKilled - a.timesKilled)
    .slice(0, 5);

  if (topSaints.length > 0) {
    console.log(chalk.bold('\n  聖老E撁E��回数 TOP5:'));
    for (const s of topSaints) {
      console.log(`    ${s.name.padEnd(12)} ${String(s.timesKilled).padStart(5)}回撃破`);
    }
  }

  console.log(chalk.bold('╚══════════════════════════════════════════╝'));
}

// ── メイン ──

const args = process.argv.slice(2);

function parseArg(name: string, defaultVal: number): number {
  // --name=value 形弁E
  const eqArg = args.find((a) => a.startsWith(`--${name}=`));
  if (eqArg) {
    const val = parseInt(eqArg.split('=')[1], 10);
    return isNaN(val) ? defaultVal : val;
  }
  // --name value 形弁E
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < args.length) {
    const val = parseInt(args[idx + 1], 10);
    return isNaN(val) ? defaultVal : val;
  }
  return defaultVal;
}

const generations = parseArg('generations', 50);
const population   = parseArg('population',  20);
const games        = parseArg('games',        50);
const verbose      = !args.includes('--quiet');

function parseFloatArg(name: string, defaultVal: number): number {
  const eqArg = args.find((a) => a.startsWith(`--${name}=`));
  if (eqArg) {
    const val = parseFloat(eqArg.split('=')[1]);
    return Number.isNaN(val) ? defaultVal : val;
  }
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < args.length) {
    const val = parseFloat(args[idx + 1]);
    return Number.isNaN(val) ? defaultVal : val;
  }
  return defaultVal;
}
function parseStringArg(name: string, defaultVal: string): string {
  const eqArg = args.find((a) => a.startsWith(`--${name}=`));
  if (eqArg) return eqArg.split('=')[1];
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return defaultVal;
}
const name = parseStringArg('name', '');
// Codex note (2026-03-14): CLI flags below were added so Claude can rerun seeded/locked training batches. Benchmark flags were added to score candidates against beta.
const seedName = parseStringArg('seed-name', '');
const lock = parseStringArg('lock', '');
const benchmarkName = parseStringArg('benchmark-name', '');
const benchmarkWeight = parseFloatArg('benchmark-weight', 1.5);
const benchmarkMarginWeight = parseFloatArg('benchmark-margin-weight', 0.15);

runEvolution({ generations, population, games, verbose, name, seedName, lock, benchmarkName, benchmarkWeight, benchmarkMarginWeight }).catch((err) => {
  console.error(chalk.red('エラー:'), err);
  process.exit(1);
});



