// 魔女ゲー 遺伝的アルゴリズム 進化ランナー
// AI戦略パラメータを自動進化させて最強の魔女AIを育てる
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createMajoGame, getCurrentPlayer, isMajoGameOver, executeAction, getMajoFinalScores, } from '../engine/majo.js';
import { createParameterizedStrategy, DEFAULT_PARAMS, randomizeParams, mutateParams, crossoverParams, } from '../ai/majo-params.js';
import { getRandomMajoStrategy } from '../ai/majo-strategies.js';
// ── 定数 ──
const MAX_TURNS_PER_GAME = 300; // 無限ループ防止
const SURVIVOR_RATIO = 0.3; // 上位30%が生き残る
const CROSSOVER_RATIO = 0.4; // 新世代の40%は交叉で生成
const MUTATION_RATE = 0.2; // 各パラメータの突然変異確率
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');
// ── ゲーム実行 ──
/**
 * 1ゲームを実行して結果を返す
 * @param evolvedParams 進化中の個体のパラメータ（1人のプレイヤーに使用）
 * @param gamesAgainstRandomOpponents 残りプレイヤーにランダム戦略を使用
 */
async function runSingleGame(evolvedParams, playerCount = 4) {
    const evolvedPlayerIndex = Math.floor(Math.random() * playerCount);
    const evolvedStrategy = createParameterizedStrategy(evolvedParams);
    const players = Array.from({ length: playerCount }, (_, i) => {
        if (i === evolvedPlayerIndex) {
            return {
                id: `p${i}`,
                name: `進化型`,
                type: 'ai',
                strategyId: evolvedStrategy.id,
            };
        }
        const opponentStrategy = getRandomMajoStrategy();
        return {
            id: `p${i}`,
            name: opponentStrategy.name,
            type: 'ai',
            strategyId: opponentStrategy.id,
        };
    });
    let state = await createMajoGame(players);
    let turnCount = 0;
    // 全プレイヤーの戦略を準備
    const strategies = players.map((p, i) => {
        if (i === evolvedPlayerIndex)
            return evolvedStrategy;
        return getRandomMajoStrategy();
    });
    // strategyIdをランナーと合わせるため、strategyIdでの索引は不要（直接strategiesを使う）
    while (!isMajoGameOver(state) && turnCount < MAX_TURNS_PER_GAME) {
        const current = getCurrentPlayer(state);
        const playerIdx = state.players.findIndex((p) => p.config.id === current.config.id);
        const strategy = strategies[playerIdx];
        try {
            const { action } = strategy.selectAction(state, current.config.id);
            state = executeAction(state, action);
        }
        catch {
            // エラーが起きたらパス
            try {
                state = executeAction(state, { type: 'pass', playerId: current.config.id });
            }
            catch {
                // パスも失敗したら次のプレイヤーへ（無限ループ防止）
                break;
            }
        }
        turnCount++;
    }
    const scores = getMajoFinalScores(state);
    return { scores, finalState: state, evolvedPlayerIndex };
}
/**
 * 個体の適応度を計算（複数ゲームの平均VP）
 */
async function evaluateIndividual(individual, gamesPerEval, cardStats) {
    let totalVP = 0;
    let wins = 0;
    for (let g = 0; g < gamesPerEval; g++) {
        const { scores, finalState, evolvedPlayerIndex } = await runSingleGame(individual.params);
        const evolvedPlayerId = `p${evolvedPlayerIndex}`;
        const evolvedScore = scores.find((s) => s.playerId === evolvedPlayerId);
        if (evolvedScore) {
            totalVP += evolvedScore.victoryPoints;
            if (evolvedScore.rank === 1)
                wins++;
        }
        // カード統計の更新
        updateCardStats(cardStats, finalState, scores, evolvedPlayerId);
    }
    return {
        ...individual,
        fitness: totalVP / gamesPerEval,
        games: individual.games + gamesPerEval,
        wins: individual.wins + wins,
    };
}
// ── カード統計 ──
function initCardStats() {
    return {
        tools: {},
        saints: {},
        relics: {},
        strategies: {},
        gameLength: { totalRounds: 0, totalTurns: 0, games: 0 },
        totalGames: 0,
    };
}
function updateCardStats(stats, finalState, scores, _evolvedPlayerId) {
    stats.totalGames++;
    // ゲーム長統計
    stats.gameLength.totalRounds += finalState.round;
    stats.gameLength.totalTurns += finalState.history.length;
    stats.gameLength.games++;
    // 全プレイヤーの最終状態からカード統計を更新
    for (const player of finalState.players) {
        const scoreEntry = scores.find((s) => s.playerId === player.config.id);
        const playerVP = scoreEntry?.victoryPoints ?? 0;
        const strategyId = player.config.strategyId ?? 'unknown';
        // 魔導具統計
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
        // 未所持魔導具の記録
        for (const toolId of Object.keys(stats.tools)) {
            if (!ownedToolIds.has(toolId)) {
                stats.tools[toolId].totalVPWhenNotOwned += playerVP;
                stats.tools[toolId].gamesWhenNotOwned++;
            }
        }
        // 聖者統計（このプレイヤーが獲得した聖者）
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
        // 未所持聖者の記録（聖者デッキ・展示にいる聖者 + 他プレイヤーが持つ聖者を含む全聖者）
        for (const saintId of Object.keys(stats.saints)) {
            if (!ownedSaintIds.has(saintId)) {
                stats.saints[saintId].totalVPWhenNotOwned += playerVP;
                stats.saints[saintId].gamesWhenNotOwned++;
            }
        }
        // 聖者デッキ・展示の聖者もstats初期化（全聖者が記録されるように）
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
        // 聖遺物統計
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
        // 戦略統計
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
        if (scoreEntry?.rank === 1)
            ss.wins++;
        ss.totalTools += player.magicTools.length;
        ss.totalSaints += player.saints.length;
        ss.totalRelics += player.relics.length;
        ss.totalMana += player.mana + player.tappedMana;
    }
    // use_relicアクションの使用回数をカウント + 魔道具取得ラウンド追跡
    let currentRound = 1;
    for (const action of finalState.history) {
        if (action.type === 'round_end') {
            currentRound++;
        }
        else if (action.type === 'use_relic') {
            const relicId = action.relicId;
            if (stats.relics[relicId]) {
                stats.relics[relicId].timesUsed++;
            }
        }
        else if ((action.type === 'field_action' || action.type === 'use_familiar') &&
            action.details.action === 'research') {
            const toolId = action.details.toolId;
            if (stats.tools[toolId]) {
                stats.tools[toolId].totalAcquireRound += currentRound;
                stats.tools[toolId].acquireCount++;
            }
        }
        else if (action.type === 'select_free_tool') {
            const toolId = action.toolId;
            if (stats.tools[toolId]) {
                stats.tools[toolId].totalAcquireRound += currentRound;
                stats.tools[toolId].acquireCount++;
            }
        }
    }
}
// ── ファイル保存 ──
function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}
function saveEvolvedParams(params, generation, fitness) {
    ensureDataDir();
    const data = {
        generation,
        fitness,
        params,
        savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(DATA_DIR, 'evolved-params.json'), JSON.stringify(data, null, 2), 'utf-8');
}
function saveCardStats(stats) {
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
    fs.writeFileSync(path.join(DATA_DIR, 'card-stats.json'), JSON.stringify(output, null, 2), 'utf-8');
}
// ── 表示ヘルパー ──
function formatParams(params) {
    return [
        `VP重${params.saintVPWeight.toFixed(2)}`,
        `聖遺物重${params.saintRelicWeight.toFixed(2)}`,
        `0VP重${params.saintZeroVPWeight.toFixed(2)}`,
        `魔導具max${params.toolBuyMaxCount.toFixed(1)}`,
        `魔女R${params.witchRoundThreshold.toFixed(1)}`,
        `戦闘優先${params.combatBeforePurchase.toFixed(2)}`,
        `聖遺物積極${params.relicAggressiveness.toFixed(2)}`,
        `実績聖${params.achievementRelicWeight.toFixed(2)}`,
    ].join(' | ');
}
function printGenerationStats(generation, population, elapsed) {
    const sorted = [...population].sort((a, b) => b.fitness - a.fitness);
    const best = sorted[0];
    const avgFitness = population.reduce((s, i) => s + i.fitness, 0) / population.length;
    const worstFitness = sorted[sorted.length - 1].fitness;
    console.log(chalk.bold.yellow(`\n╔══ 世代 ${String(generation).padStart(3)} ══════════════════════════════╗`));
    console.log(chalk.green(`  最高適応度: ${chalk.bold(best.fitness.toFixed(3))} VP  勝率: ${((best.wins / Math.max(best.games, 1)) * 100).toFixed(1)}%`));
    console.log(chalk.cyan(`  平均適応度: ${avgFitness.toFixed(3)} VP`));
    console.log(chalk.gray(`  最低適応度: ${worstFitness.toFixed(3)} VP`));
    console.log(chalk.gray(`  経過時間:   ${(elapsed / 1000).toFixed(1)}秒`));
    console.log(chalk.bold(`  最優秀パラメータ:`));
    console.log(chalk.cyan(`    ${formatParams(best.params)}`));
    console.log(chalk.bold.yellow(`╚══════════════════════════════════════════╝`));
}
function printProgress(current, total, label) {
    const pct = Math.floor((current / total) * 100);
    const barLen = 30;
    const filled = Math.floor((current / total) * barLen);
    const bar = chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(barLen - filled));
    process.stdout.write(`\r  ${label} [${bar}] ${pct}% (${current}/${total})`);
}
// ── 遺伝的アルゴリズム メインループ ──
async function runEvolution(options) {
    const { generations, population: popSize, games: gamesPerEval, verbose } = options;
    console.log(chalk.bold('\n╔══════════════════════════════════════════╗'));
    console.log(chalk.bold('║   魔女ゲー 遺伝的アルゴリズム 進化実験  ║'));
    console.log(chalk.bold('╚══════════════════════════════════════════╝'));
    console.log(chalk.cyan(`  世代数: ${generations}  集団サイズ: ${popSize}  評価ゲーム数/個体: ${gamesPerEval}`));
    console.log(chalk.gray(`  生存率: ${(SURVIVOR_RATIO * 100).toFixed(0)}%  交叉率: ${(CROSSOVER_RATIO * 100).toFixed(0)}%  突然変異率: ${(MUTATION_RATE * 100).toFixed(0)}%\n`));
    // ── 初期集団の生成 ──
    console.log(chalk.bold('初期集団を生成中...'));
    const cardStats = initCardStats();
    let individuals = [
        // デフォルトパラメータを1つ含める（ベースライン）
        { params: DEFAULT_PARAMS, fitness: 0, games: 0, wins: 0 },
        // 残りはランダム
        ...Array.from({ length: popSize - 1 }, () => ({
            params: randomizeParams(),
            fitness: 0,
            games: 0,
            wins: 0,
        })),
    ];
    // ── 初期評価 ──
    console.log(chalk.bold('初期集団を評価中...'));
    for (let i = 0; i < individuals.length; i++) {
        printProgress(i + 1, individuals.length, '評価');
        individuals[i] = await evaluateIndividual(individuals[i], gamesPerEval, cardStats);
    }
    console.log('');
    // 初期世代の表示
    printGenerationStats(0, individuals, 0);
    saveCardStats(cardStats);
    let allTimeBest = individuals.sort((a, b) => b.fitness - a.fitness)[0];
    // ── 進化ループ ──
    for (let gen = 1; gen <= generations; gen++) {
        const genStart = Date.now();
        // ソートして適応度順に並べる
        individuals.sort((a, b) => b.fitness - a.fitness);
        // 上位を生存者として保持
        const survivorCount = Math.max(2, Math.floor(popSize * SURVIVOR_RATIO));
        const survivors = individuals.slice(0, survivorCount);
        // 新世代の生成
        const newGeneration = [...survivors];
        const crossoverCount = Math.floor(popSize * CROSSOVER_RATIO);
        const mutationCount = popSize - survivorCount - crossoverCount;
        // 交叉による子供生成
        for (let i = 0; i < crossoverCount; i++) {
            const parentA = survivors[Math.floor(Math.random() * survivors.length)];
            const parentB = survivors[Math.floor(Math.random() * survivors.length)];
            const childParams = mutateParams(crossoverParams(parentA.params, parentB.params), MUTATION_RATE * 0.5);
            newGeneration.push({ params: childParams, fitness: 0, games: 0, wins: 0 });
        }
        // 突然変異による子供生成
        for (let i = 0; i < mutationCount; i++) {
            const parent = survivors[Math.floor(Math.random() * survivors.length)];
            const childParams = mutateParams(parent.params, MUTATION_RATE);
            newGeneration.push({ params: childParams, fitness: 0, games: 0, wins: 0 });
        }
        // 新個体の評価（既存生存者は評価済みなので新個体のみ）
        if (verbose) {
            console.log(chalk.bold(`\n世代 ${gen}: 新個体${newGeneration.length - survivorCount}体を評価中...`));
        }
        for (let i = survivorCount; i < newGeneration.length; i++) {
            if (verbose)
                printProgress(i - survivorCount + 1, newGeneration.length - survivorCount, '新個体評価');
            newGeneration[i] = await evaluateIndividual(newGeneration[i], gamesPerEval, cardStats);
        }
        if (verbose)
            console.log('');
        individuals = newGeneration;
        const elapsed = Date.now() - genStart;
        printGenerationStats(gen, individuals, elapsed);
        // 最優秀個体の更新
        const genBest = individuals.sort((a, b) => b.fitness - a.fitness)[0];
        if (genBest.fitness > allTimeBest.fitness) {
            allTimeBest = genBest;
            console.log(chalk.bold.green(`  新記録！ 適応度 ${genBest.fitness.toFixed(3)} VP`));
            saveEvolvedParams(genBest.params, gen, genBest.fitness);
        }
        // カード統計を毎世代保存
        saveCardStats(cardStats);
    }
    // ── 最終結果 ──
    console.log(chalk.bold.yellow('\n╔══════════════════════════════════════════╗'));
    console.log(chalk.bold.yellow('║              進化完了！                  ║'));
    console.log(chalk.bold.yellow('╚══════════════════════════════════════════╝'));
    console.log(chalk.green(`\n全時間最優秀パラメータ (適応度: ${allTimeBest.fitness.toFixed(3)} VP):`));
    const params = allTimeBest.params;
    const paramEntries = Object.entries(params);
    for (const [key, val] of paramEntries) {
        const defaultVal = DEFAULT_PARAMS[key];
        const diff = val - defaultVal;
        const diffStr = diff >= 0
            ? chalk.green(`+${diff.toFixed(3)}`)
            : chalk.red(`${diff.toFixed(3)}`);
        console.log(`  ${chalk.bold(key.padEnd(25))}: ${val.toFixed(3).padStart(8)}  (デフォルト比 ${diffStr})`);
    }
    console.log(chalk.gray(`\n  保存先: ${path.join(DATA_DIR, 'evolved-params.json')}`));
    console.log(chalk.gray(`  カード統計: ${path.join(DATA_DIR, 'card-stats.json')}`));
    // カード統計のサマリーを表示
    console.log(chalk.bold('\n╔══ カード統計サマリー ══════════════════════╗'));
    console.log(chalk.bold(`  集計ゲーム数: ${cardStats.totalGames}`));
    // 魔導具ランキング（win correlation順）
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
        console.log(chalk.bold('\n  魔導具 勝利貢献度 TOP5:'));
        for (const t of topTools) {
            const corrStr = t.winCorr >= 0
                ? chalk.green(`+${t.winCorr.toFixed(2)}`)
                : chalk.red(`${t.winCorr.toFixed(2)}`);
            console.log(`    ${t.name.padEnd(12)} 購入${String(t.timesBought).padStart(4)}回  所持時平均VP: ${(t.totalVPWhenOwned / t.gamesWhenOwned).toFixed(2)}  差: ${corrStr}`);
        }
    }
    // 聖者ランキング（撃破回数順）
    const topSaints = Object.values(cardStats.saints)
        .sort((a, b) => b.timesKilled - a.timesKilled)
        .slice(0, 5);
    if (topSaints.length > 0) {
        console.log(chalk.bold('\n  聖者 撃破回数 TOP5:'));
        for (const s of topSaints) {
            console.log(`    ${s.name.padEnd(12)} ${String(s.timesKilled).padStart(5)}回撃破`);
        }
    }
    console.log(chalk.bold('╚══════════════════════════════════════════╝'));
}
// ── メイン ──
const args = process.argv.slice(2);
function parseArg(name, defaultVal) {
    const arg = args.find((a) => a.startsWith(`--${name}=`));
    if (!arg)
        return defaultVal;
    const val = parseInt(arg.split('=')[1], 10);
    return isNaN(val) ? defaultVal : val;
}
const generations = parseArg('generations', 50);
const population = parseArg('population', 20);
const games = parseArg('games', 50);
const verbose = !args.includes('--quiet');
runEvolution({ generations, population, games, verbose }).catch((err) => {
    console.error(chalk.red('エラー:'), err);
    process.exit(1);
});
