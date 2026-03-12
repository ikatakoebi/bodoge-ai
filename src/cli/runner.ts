import chalk from 'chalk';
import minimist from 'minimist';
import * as readline from 'readline';
import * as fs from 'fs';
import * as crypto from 'crypto';

import type { PlayerConfig, RoundResult, ReplayLog, GameState } from '../engine/types.js';
import {
  createGame,
  revealPointCard,
  submitSelection,
  resolveRound,
  isGameOver,
  getFinalScores,
} from '../engine/game.js';
import { strategies, strategyIds, getStrategy, getRandomStrategy } from '../ai/strategies.js';

// ========== 出力ユーティリティ ==========

function formatPointCard(value: number): string {
  if (value > 0) {
    return chalk.green.bold(`+${value}`);
  } else {
    return chalk.red.bold(`${value}`);
  }
}

function formatHandCard(value: number): string {
  return chalk.yellow.bold(`[${value}]`);
}

function formatPlayerName(name: string, isHuman = false): string {
  return isHuman ? chalk.cyan.bold(name) : chalk.white.bold(name);
}

function printSeparator(char = '─', length = 60): void {
  console.log(chalk.gray(char.repeat(length)));
}

function printTitle(): void {
  console.log('');
  console.log(chalk.bgRed.white.bold('  🦅 ハゲタカの餌食 AI自動プレイエンジン  '));
  console.log('');
}

function printRoundHeader(round: number, total: number, pointCard: number, carryOver: number[]): void {
  printSeparator('═');
  console.log(
    chalk.bold(`ラウンド ${chalk.magenta(round)} / ${total}`)
  );

  if (carryOver.length > 0) {
    const carryStr = carryOver.map((c) => formatPointCard(c)).join(', ');
    console.log(`  キャリーオーバー: ${carryStr}`);
  }

  const allCards = [...carryOver, pointCard];
  const total_pts = allCards.reduce((s, c) => s + c, 0);
  console.log(`  今回の得点カード: ${formatPointCard(pointCard)}` +
    (carryOver.length > 0 ? chalk.gray(` (合計 ${total_pts > 0 ? '+' : ''}${total_pts}点)`) : ''));
  printSeparator();
}

function printSelections(
  result: RoundResult,
  players: PlayerConfig[],
  verbose: boolean,
  humanId?: string
): void {
  console.log(chalk.bold('  各プレイヤーの選択:'));

  for (const sel of result.selections) {
    const config = players.find((p) => p.id === sel.playerId)!;
    const nameStr = formatPlayerName(config.name, config.id === humanId);
    const isWinner = sel.playerId === result.winnerId;
    const winMark = isWinner ? chalk.green(' ← 取得！') : '';
    console.log(`    ${nameStr}: ${formatHandCard(sel.card)}${winMark}`);

    if (verbose && result.reasoning?.[sel.playerId]) {
      console.log(chalk.gray(`      💭 ${result.reasoning[sel.playerId]}`));
    }
  }
}

function printRoundResult(result: RoundResult, players: PlayerConfig[]): void {
  const totalValue = [...result.carryOver, result.pointCard].reduce((s, c) => s + c, 0);

  if (result.winnerId) {
    const winner = players.find((p) => p.id === result.winnerId)!;
    console.log(
      `\n  結果: ${chalk.green.bold(winner.name)} が ${formatPointCard(totalValue)} を獲得！`
    );
  } else {
    console.log(
      `\n  結果: ${chalk.yellow.bold('誰も取れず')} → 次のラウンドにキャリーオーバー`
    );
  }
}

function printScoreTable(state: GameState): void {
  printSeparator();
  console.log(chalk.bold('  現在のスコア:'));

  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  for (const p of sorted) {
    const bar = p.score >= 0
      ? chalk.green('█'.repeat(Math.min(Math.abs(p.score), 20)))
      : chalk.red('█'.repeat(Math.min(Math.abs(p.score), 20)));
    console.log(`    ${formatPlayerName(p.config.name).padEnd(20)} ${String(p.score).padStart(4)}点  ${bar}`);
  }
}

function printFinalResults(state: GameState): void {
  const scores = getFinalScores(state);
  console.log('');
  printSeparator('═');
  console.log(chalk.bgGreen.black.bold('  🏆 最終結果  '));
  printSeparator('═');

  const medals = ['🥇', '🥈', '🥉', '  '];

  for (const s of scores) {
    const medal = medals[Math.min(s.rank - 1, 3)];
    const nameStr = chalk.bold(s.name.padEnd(16));
    const scoreStr = s.score >= 0
      ? chalk.green.bold(`+${s.score}点`)
      : chalk.red.bold(`${s.score}点`);
    console.log(`  ${medal} ${s.rank}位  ${nameStr} ${scoreStr}`);
  }
  printSeparator('═');
  console.log('');
}

// ========== auto モード ==========

async function runAutoMode(
  playerCount: number,
  gameCount: number,
  verbose: boolean,
  strategyList: string[],
  logFile: string | null
): Promise<void> {
  console.log(chalk.bold(`\n🤖 自動対戦モード: ${gameCount}ゲーム × ${playerCount}人`));

  // 戦略勝率統計
  const winCounts: Record<string, number> = {};
  const gameCounts: Record<string, number> = {};

  for (const sid of strategyIds) {
    winCounts[sid] = 0;
    gameCounts[sid] = 0;
  }

  const replayLogs: ReplayLog[] = [];

  for (let g = 0; g < gameCount; g++) {
    if (gameCount > 1 && !verbose) {
      process.stdout.write(`\rゲーム ${g + 1}/${gameCount} 実行中...`);
    }

    // プレイヤー設定
    const assignedStrategies = strategyList.length >= playerCount
      ? strategyList.slice(0, playerCount)
      : Array.from({ length: playerCount }, (_, i) =>
          strategyList[i] ?? getRandomStrategy().id
        );

    const players: PlayerConfig[] = assignedStrategies.map((sid, i) => {
      const strategy = getStrategy(sid);
      return {
        id: `player_${i + 1}`,
        name: `${strategy.name}AI`,
        type: 'ai',
        strategyId: sid,
        personalityDesc: strategy.personality,
      };
    });

    // 同じ戦略が複数いる場合に名前を区別
    const nameCounts: Record<string, number> = {};
    for (const p of players) {
      nameCounts[p.name] = (nameCounts[p.name] ?? 0) + 1;
    }
    const nameIdx: Record<string, number> = {};
    for (const p of players) {
      if (nameCounts[p.name] > 1) {
        nameIdx[p.name] = (nameIdx[p.name] ?? 0) + 1;
        p.name = `${p.name}${nameIdx[p.name]}`;
      }
    }

    let state = createGame(players);

    const gameId = crypto.randomUUID();

    if (verbose && gameCount === 1) {
      printTitle();
      console.log(chalk.bold('プレイヤー:'));
      for (const p of players) {
        const strategy = getStrategy(p.strategyId!);
        console.log(`  ${formatPlayerName(p.name)} — ${strategy.name} (${strategy.personality})`);
      }
      console.log('');
    }

    // ゲームループ
    while (!isGameOver(state)) {
      state = revealPointCard(state);

      if (state.currentPointCard === null) break;

      if (verbose && gameCount === 1) {
        printRoundHeader(state.round, state.totalRounds, state.currentPointCard, state.carryOver);
      }

      // AIの手を収集
      const reasoning: Record<string, string> = {};

      for (const player of state.players) {
        const strategy = getStrategy(player.config.strategyId!);
        const { card, reasoning: reason } = strategy.selectCard(state, player.config.id);
        reasoning[player.config.id] = reason;
        state = submitSelection(state, player.config.id, card);
      }

      const { state: newState, result } = resolveRound(state, reasoning);
      state = newState;

      if (verbose && gameCount === 1) {
        printSelections(result, players, true);
        printRoundResult(result, players);
        printScoreTable(state);
        console.log('');
      }
    }

    // 最終結果
    if (verbose && gameCount === 1) {
      printFinalResults(state);
    }

    // 統計集計
    const finalScores = getFinalScores(state);
    const winner = finalScores.find((s) => s.rank === 1);
    if (winner) {
      const winnerPlayer = players.find((p) => p.id === winner.playerId)!;
      if (winnerPlayer.strategyId) {
        winCounts[winnerPlayer.strategyId] = (winCounts[winnerPlayer.strategyId] ?? 0) + 1;
      }
    }

    for (const p of players) {
      if (p.strategyId) {
        gameCounts[p.strategyId] = (gameCounts[p.strategyId] ?? 0) + 1;
      }
    }

    // リプレイログ
    const log: ReplayLog = {
      gameId,
      gameName: 'ハゲタカの餌食',
      timestamp: new Date().toISOString(),
      players,
      rounds: state.history,
      finalScores,
    };
    replayLogs.push(log);
  }

  // 複数ゲームの統計表示
  if (gameCount > 1) {
    console.log('\n');
    printSeparator('═');
    console.log(chalk.bgBlue.white.bold(`  📊 ${gameCount}ゲーム統計  `));
    printSeparator('═');
    console.log(chalk.bold('  戦略別勝率:'));

    const statsEntries = strategyIds
      .filter((sid) => gameCounts[sid] > 0)
      .map((sid) => ({
        sid,
        name: strategies[sid].name,
        wins: winCounts[sid],
        games: gameCounts[sid],
        rate: gameCounts[sid] > 0 ? (winCounts[sid] / gameCounts[sid]) * 100 : 0,
      }))
      .sort((a, b) => b.rate - a.rate);

    for (const entry of statsEntries) {
      const bar = chalk.blue('█'.repeat(Math.round(entry.rate / 5)));
      const rateStr = entry.rate.toFixed(1).padStart(5);
      console.log(
        `    ${entry.name.padEnd(18)} ${rateStr}%  ${bar}  (${entry.wins}勝/${entry.games}戦)`
      );
    }
    printSeparator('═');
  }

  // ログ出力
  if (logFile) {
    const output = gameCount === 1 ? replayLogs[0] : replayLogs;
    fs.writeFileSync(logFile, JSON.stringify(output, null, 2), 'utf-8');
    console.log(chalk.gray(`\nリプレイログを保存: ${logFile}`));
  }
}

// ========== play モード ==========

async function runPlayMode(
  playerCount: number,
  verbose: boolean,
  strategyList: string[],
  logFile: string | null
): Promise<void> {
  printTitle();
  console.log(chalk.cyan.bold('🎮 人間プレイヤーモード'));
  console.log('');

  const humanName = '人間プレイヤー';
  const humanId = 'human_player';

  // AI プレイヤーを設定
  const aiCount = playerCount - 1;
  const aiStrategies = strategyList.length >= aiCount
    ? strategyList.slice(0, aiCount)
    : Array.from({ length: aiCount }, (_, i) =>
        strategyList[i] ?? getRandomStrategy().id
      );

  const players: PlayerConfig[] = [
    { id: humanId, name: humanName, type: 'human' },
    ...aiStrategies.map((sid, i) => {
      const strategy = getStrategy(sid);
      return {
        id: `ai_${i + 1}`,
        name: `${strategy.name}AI`,
        type: 'ai' as const,
        strategyId: sid,
        personalityDesc: strategy.personality,
      };
    }),
  ];

  console.log(chalk.bold('プレイヤー:'));
  for (const p of players) {
    if (p.type === 'human') {
      console.log(`  ${formatPlayerName(p.name, true)} ← あなた`);
    } else {
      const strategy = getStrategy(p.strategyId!);
      console.log(`  ${formatPlayerName(p.name)} — ${strategy.name} (${strategy.personality})`);
    }
  }
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const askQuestion = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  let state = createGame(players);

  // ゲームループ
  while (!isGameOver(state)) {
    state = revealPointCard(state);
    if (state.currentPointCard === null) break;

    const humanPlayer = state.players.find((p) => p.config.id === humanId)!;

    printRoundHeader(state.round, state.totalRounds, state.currentPointCard, state.carryOver);

    // 人間の手札表示
    const sortedHand = [...humanPlayer.hand].sort((a, b) => a - b);
    console.log(`\n  あなたの手札: ${sortedHand.map((c) => formatHandCard(c)).join(' ')}`);

    // スコア表示
    console.log(chalk.bold('\n  現在のスコア:'));
    const sortedPlayers = [...state.players].sort((a, b) => b.score - a.score);
    for (const p of sortedPlayers) {
      const isYou = p.config.id === humanId;
      const scoreStr = p.score >= 0 ? chalk.green(`+${p.score}`) : chalk.red(`${p.score}`);
      const youMark = isYou ? chalk.cyan(' ← あなた') : '';
      console.log(`    ${formatPlayerName(p.config.name, isYou).padEnd(22)} ${scoreStr}点${youMark}`);
    }
    console.log('');

    // 人間の入力
    let humanCard: number | null = null;
    while (humanCard === null) {
      const input = await askQuestion(chalk.cyan(`  カードを選んでください (1-15): `));
      const num = parseInt(input.trim(), 10);
      if (isNaN(num)) {
        console.log(chalk.red('  数字を入力してください'));
        continue;
      }
      if (!sortedHand.includes(num)) {
        console.log(chalk.red(`  ${num} は手札にありません。手札: ${sortedHand.join(', ')}`));
        continue;
      }
      humanCard = num;
    }

    state = submitSelection(state, humanId, humanCard);

    // AIの手を収集
    const reasoning: Record<string, string> = {};

    for (const player of state.players) {
      if (player.config.id === humanId) continue;
      const strategy = getStrategy(player.config.strategyId!);
      const { card, reasoning: reason } = strategy.selectCard(state, player.config.id);
      reasoning[player.config.id] = reason;
      state = submitSelection(state, player.config.id, card);
    }

    const { state: newState, result } = resolveRound(state, reasoning);
    state = newState;

    console.log('');
    printSelections(result, players, verbose, humanId);
    printRoundResult(result, players);
    console.log('');

    await askQuestion(chalk.gray('  Enterキーで次のラウンドへ...'));
  }

  rl.close();

  printFinalResults(state);

  // ログ出力
  if (logFile) {
    const finalScores = getFinalScores(state);
    const log: ReplayLog = {
      gameId: crypto.randomUUID(),
      gameName: 'ハゲタカの餌食',
      timestamp: new Date().toISOString(),
      players,
      rounds: state.history,
      finalScores,
    };
    fs.writeFileSync(logFile, JSON.stringify(log, null, 2), 'utf-8');
    console.log(chalk.gray(`リプレイログを保存: ${logFile}`));
  }
}

// ========== エントリポイント ==========

async function main(): Promise<void> {
  const args = minimist(process.argv.slice(2), {
    string: ['mode', 'log', 'strategies'],
    number: ['players', 'games'],
    boolean: ['verbose', 'help'],
    default: {
      mode: 'auto',
      players: 3,
      games: 1,
      verbose: false,
    },
  });

  if (args.help) {
    console.log(`
ハゲタカの餌食 AI自動プレイエンジン

使い方:
  npm run auto                    全員AI、1ゲーム実行
  npm run play                    人間1人 + AI
  npm run stats                   100ゲーム統計

オプション:
  --mode auto|play                実行モード (デフォルト: auto)
  --players N                     プレイヤー数 2-5 (デフォルト: 3)
  --games N                       ゲーム数 (autoモードのみ, デフォルト: 1)
  --verbose                       詳細表示 (AIの思考理由含む)
  --log FILE                      リプレイログをJSONに出力
  --strategies s1,s2,...          戦略を指定

利用可能な戦略:
${strategyIds.map((id) => `  ${id.padEnd(15)} ${strategies[id].name} — ${strategies[id].description}`).join('\n')}
`);
    return;
  }

  const mode = args.mode as 'auto' | 'play';
  const playerCount = Math.min(Math.max(args.players as number, 2), 5);
  const gameCount = Math.max(args.games as number, 1);
  const verbose = args.verbose as boolean;
  const logFile = args.log as string | null ?? null;
  const strategyList = args.strategies
    ? (args.strategies as string).split(',').map((s: string) => s.trim())
    : [];

  // 戦略バリデーション
  for (const sid of strategyList) {
    if (!strategyIds.includes(sid)) {
      console.error(chalk.red(`エラー: 戦略 "${sid}" は存在しません`));
      console.error(`利用可能: ${strategyIds.join(', ')}`);
      process.exit(1);
    }
  }

  if (mode === 'play') {
    await runPlayMode(playerCount, verbose, strategyList, logFile);
  } else {
    await runAutoMode(playerCount, gameCount, verbose, strategyList, logFile);
  }
}

main().catch((err) => {
  console.error(chalk.red('エラー:'), err);
  process.exit(1);
});
