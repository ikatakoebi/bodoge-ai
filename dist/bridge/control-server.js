/**
 * ブラウザベースのコントロールパネルサーバー
 * http://localhost:3216/ でコントロールパネルを提供する
 */
import { createServer } from 'http';
import * as crypto from 'crypto';
import { BridgeClient } from './client.js';
import { ReplayController } from './replay.js';
import { strategyIds, strategies, getStrategy, getRandomStrategy } from '../ai/strategies.js';
import { PlayController } from './play.js';
import { MajoPlayController } from './majo-play.js';
import { MajoBoardSync, MAJO_SHEET_ID } from './majo-board.js';
import { majoStrategyIds, getMajoStrategy } from '../ai/majo-strategies.js';
import { createGame, revealPointCard, submitSelection, resolveRound, isGameOver, getFinalScores, } from '../engine/game.js';
const DEFAULT_BOARD_URL = 'http://localhost:3210';
// ── グローバル状態 ────────────────────────────────────────────────────────────
let bridgeClient = null;
let inlineCtrl = null;
let playCtrl = null;
let majoPlayCtrl = null;
let majoBoardSync = null;
let currentMode = 'idle';
let logs = [];
let replayData = null;
let currentRoomId = null;
/** ボード接続直後のクリーンな状態（リプレイ開始前にリセット用） */
let cleanBoardState = null;
function addLog(msg) {
    const time = new Date().toLocaleTimeString('ja-JP');
    logs.push(`[${time}] ${msg}`);
    if (logs.length > 500)
        logs.shift();
}
// ── InlineStepController ─────────────────────────────────────────────────────
/**
 * ReplayController の stepController オプションに渡すインライン実装。
 * StepController と同じインターフェースを持つが、独自のHTTPサーバーを立てない。
 */
class InlineStepController {
    _paused = false;
    _stepResolve = null;
    _quit = false;
    _autoPlay = true;
    currentRound = 0;
    totalRounds = 0;
    statusMessage = '';
    roundResult = '';
    scores = {};
    /** Callback set by handleReplayStart to support step-back via ReplayController */
    stepBackFn = null;
    get isPaused() { return this._paused; }
    isAutoPlay() { return this._autoPlay; }
    pause() {
        this._paused = true;
        this._autoPlay = false;
    }
    resume() {
        this._paused = false;
        this._autoPlay = true;
        if (this._stepResolve) {
            const r = this._stepResolve;
            this._stepResolve = null;
            r();
        }
    }
    step() {
        // シングルステップ: 一度だけ進めてまた一時停止
        this._paused = true;
        this._autoPlay = false;
        if (this._stepResolve) {
            const r = this._stepResolve;
            this._stepResolve = null;
            r();
        }
    }
    async back() {
        if (this.stepBackFn)
            return this.stepBackFn();
        return false;
    }
    stop() {
        this._quit = true;
        this._paused = false;
        if (this._stepResolve) {
            const r = this._stepResolve;
            this._stepResolve = null;
            r();
        }
    }
    setRoundInfo(round, total) {
        this.currentRound = round;
        this.totalRounds = total;
    }
    setStatus(msg) {
        this.statusMessage = msg;
        addLog(msg);
    }
    setRoundResult(msg) {
        this.roundResult = msg;
    }
    setScores(s) {
        this.scores = { ...s };
    }
    async delayOrStep(ms) {
        if (this._quit)
            return false;
        if (this._paused) {
            await new Promise((r) => { this._stepResolve = r; });
            if (this._quit)
                return false;
            // step() が呼ばれた場合: _paused = true のまま → 次の delayOrStep でまた待機
            // resume() が呼ばれた場合: _paused = false → 通常再生に戻る
            return true;
        }
        await new Promise((r) => setTimeout(r, ms));
        return !this._quit;
    }
    isQuit() { return this._quit; }
    getPort() { return 3216; }
    destroy() { }
}
// ── ボディパーサー ────────────────────────────────────────────────────────────
function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (chunk) => { data += chunk.toString(); });
        req.on('end', () => resolve(data));
        req.on('error', reject);
    });
}
// ── リプレイ生成 ──────────────────────────────────────────────────────────────
/**
 * AI vs AI のゲームを1回実行してリプレイログを返す。
 */
function generateReplay(playerCount, requestedStrategyIds) {
    // プレイヤー設定
    const assignedStrategies = requestedStrategyIds.length >= playerCount
        ? requestedStrategyIds.slice(0, playerCount)
        : Array.from({ length: playerCount }, (_, i) => requestedStrategyIds[i] ?? getRandomStrategy().id);
    const players = assignedStrategies.map((sid, i) => {
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
    const nameCounts = {};
    for (const p of players) {
        nameCounts[p.name] = (nameCounts[p.name] ?? 0) + 1;
    }
    const nameIdx = {};
    for (const p of players) {
        if (nameCounts[p.name] > 1) {
            nameIdx[p.name] = (nameIdx[p.name] ?? 0) + 1;
            p.name = `${p.name}${nameIdx[p.name]}`;
        }
    }
    let state = createGame(players);
    const gameId = crypto.randomUUID();
    // ゲームループ
    while (!isGameOver(state)) {
        state = revealPointCard(state);
        if (state.currentPointCard === null)
            break;
        const reasoning = {};
        for (const player of state.players) {
            const strategy = getStrategy(player.config.strategyId);
            const { card, reasoning: reason } = strategy.selectCard(state, player.config.id);
            reasoning[player.config.id] = reason;
            state = submitSelection(state, player.config.id, card);
        }
        const { state: newState } = resolveRound(state, reasoning);
        state = newState;
    }
    const finalScores = getFinalScores(state);
    return {
        gameId,
        gameName: 'ハゲタカの餌食',
        timestamp: new Date().toISOString(),
        players,
        rounds: state.history,
        finalScores,
    };
}
/** 接続済みか確認する。未接続ならエラーを投げる */
function requireConnected() {
    if (!bridgeClient) {
        throw new Error('先にルームに接続してください（上の「接続」ボタンから）');
    }
}
// ── API ハンドラ ──────────────────────────────────────────────────────────────
async function handleSetupBoard(body) {
    if (!bridgeClient)
        return { ok: false, error: '先にルームに接続してください' };
    const params = JSON.parse(body || '{}');
    const sheetUrl = params.sheetUrl || '';
    const playerCount = Math.min(Math.max(params.playerCount ?? 3, 1), 5);
    // スプレッドシートIDを抽出
    const m = sheetUrl.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/);
    if (!m)
        return { ok: false, error: 'スプレッドシートURLが正しくありません' };
    const sheetId = m[1];
    addLog(`ゲーム設定中... (スプシ: ${sheetId}, ${playerCount}人)`);
    try {
        // Socket.ioサーバーの /api/setup-game を呼ぶ
        const serverUrl = DEFAULT_BOARD_URL;
        const res = await fetch(`${serverUrl}/api/setup-game?id=${sheetId}&players=${playerCount}`);
        const data = await res.json();
        if (!data.ok || !data.gameState) {
            return { ok: false, error: data.error || 'セットアップに失敗しました' };
        }
        // ボードにゲーム状態をpush
        const state = bridgeClient.getState();
        const gameState = data.gameState;
        // 既存のstateにゲームデータをマージして送信
        const newState = {
            ...state,
            cardDefinitions: gameState.cardDefinitions,
            areas: gameState.areas,
            cardTemplates: gameState.cardTemplates,
            cardInstances: gameState.cardInstances,
            cardStacks: gameState.cardStacks,
            counters: gameState.counters,
            players: gameState.players,
            counterDefs: gameState.counterDefs,
        };
        bridgeClient.restoreState(newState);
        bridgeClient.sendState();
        // cleanBoardStateを更新
        cleanBoardState = JSON.parse(JSON.stringify(bridgeClient.getState()));
        const info = data.info;
        addLog(`ゲーム設定完了: カード${info.cards}種, エリア${info.areas}, ${info.players}人`);
        if (data.logs)
            data.logs.forEach((l) => addLog(`  ${l}`));
        return { ok: true, info: data.info };
    }
    catch (e) {
        const msg = e.message;
        addLog(`ゲーム設定エラー: ${msg}`);
        return { ok: false, error: msg };
    }
}
async function handleConnect(body) {
    const params = JSON.parse(body);
    const boardUrl = params.boardUrl || DEFAULT_BOARD_URL;
    const roomId = params.roomId || undefined;
    // 既存の接続を切断
    if (bridgeClient) {
        bridgeClient.disconnect();
        bridgeClient = null;
        currentRoomId = null;
        addLog('既存の接続を切断しました');
    }
    addLog(`ボードに接続中: ${boardUrl} ...`);
    bridgeClient = new BridgeClient({
        url: boardUrl,
        roomId,
        playerName: 'AIブリッジ',
    });
    // 接続確立を待つ（タイムアウト 10 秒）
    await Promise.race([
        bridgeClient.waitForState(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('接続タイムアウト (10秒)')), 10000)),
    ]);
    currentRoomId = await bridgeClient.waitForRoomId();
    // ボード接続直後のクリーンな状態を保存（リプレイ再開始時のリセット用）
    cleanBoardState = JSON.parse(JSON.stringify(bridgeClient.getState()));
    addLog(`接続しました！ルームID: ${currentRoomId}`);
    return { ok: true, roomId: currentRoomId };
}
async function handleDisconnect() {
    if (bridgeClient) {
        bridgeClient.disconnect();
        bridgeClient = null;
        currentRoomId = null;
        addLog('切断しました');
    }
    return { ok: true };
}
async function handleReplayUpload(body) {
    try {
        replayData = JSON.parse(body);
        addLog(`リプレイデータ読み込み完了: ${replayData.gameName} (${replayData.rounds.length}ラウンド, ${replayData.players.length}人)`);
        return {
            ok: true,
            gameName: replayData.gameName,
            rounds: replayData.rounds.length,
            players: replayData.players.map((p) => p.name),
        };
    }
    catch (e) {
        return { ok: false, error: `JSONパースエラー: ${e.message}` };
    }
}
async function handleReplayGenerate(body) {
    try {
        const params = JSON.parse(body || '{}');
        const playerCount = Math.min(Math.max(params.players ?? 3, 2), 5);
        const requestedStrategies = params.strategies ?? [];
        const autoStart = params.autoStart ?? false;
        // 戦略バリデーション
        for (const sid of requestedStrategies) {
            if (!strategyIds.includes(sid)) {
                return { ok: false, error: `戦略 "${sid}" は存在しません。利用可能: ${strategyIds.join(', ')}` };
            }
        }
        addLog(`AI対戦を生成中... (${playerCount}人)`);
        const log = generateReplay(playerCount, requestedStrategies);
        replayData = log;
        const strategyNames = log.players.map((p) => {
            const sid = p.strategyId ?? '';
            return strategies[sid]?.name ?? sid;
        });
        addLog(`AI対戦生成完了: ${log.rounds.length}ラウンド / 戦略: ${strategyNames.join(', ')}`);
        // autoStart: 生成後に自動でリプレイ開始
        if (autoStart) {
            const delay = params.delay ?? 2000;
            await handleReplayStart(JSON.stringify({ delay }));
        }
        return {
            ok: true,
            gameName: log.gameName,
            rounds: log.rounds.length,
            players: log.players.map((p) => p.name),
            strategies: strategyNames,
            finalScores: log.finalScores,
            log,
        };
    }
    catch (e) {
        const msg = e.message;
        addLog(`AI対戦生成エラー: ${msg}`);
        return { ok: false, error: msg };
    }
}
async function handleReplayStart(body) {
    if (!bridgeClient)
        return { ok: false, error: '先にルームに接続してください' };
    if (!replayData)
        return { ok: false, error: 'リプレイデータがありません。先にJSONをアップロードするかAI対戦を生成してください' };
    if (currentMode !== 'idle')
        return { ok: false, error: `現在 ${currentMode} モードで実行中です` };
    const params = JSON.parse(body || '{}');
    const delay = params.delay ?? 2000;
    // ボードをクリーン状態にリセット（前回のリプレイで移動したカードを元に戻す）
    if (cleanBoardState) {
        bridgeClient.restoreState(cleanBoardState);
        bridgeClient.sendState();
        addLog('ボードを初期状態にリセットしました');
    }
    const ctrl = new InlineStepController();
    inlineCtrl = ctrl;
    // リプレイは一時停止状態で開始（ユーザーが手動で進めるのがデフォルト）
    ctrl.pause();
    const replayCtrl = new ReplayController(replayData, bridgeClient, {
        delay,
        stepController: ctrl,
    });
    // Wire up step-back support
    ctrl.stepBackFn = () => replayCtrl.stepBack();
    currentMode = 'replay';
    addLog(`リプレイ開始 (一時停止状態 / ディレイ: ${delay}ms)`);
    replayCtrl.run().then(() => {
        addLog('リプレイ完了！');
        if (inlineCtrl) {
            inlineCtrl.pause();
            inlineCtrl.setStatus('リプレイ完了');
            inlineCtrl.setRoundResult('🏁 リプレイ完了！');
        }
        // Don't set to idle — keep replay mode so back button works
    }).catch((err) => {
        addLog(`リプレイエラー: ${err.message}`);
        currentMode = 'idle';
        inlineCtrl = null;
    });
    return { ok: true };
}
async function handleReplayPause() {
    if (!inlineCtrl)
        return { ok: false, error: 'リプレイが実行されていません' };
    inlineCtrl.pause();
    addLog('一時停止');
    return { ok: true, state: 'paused' };
}
async function handleReplayResume() {
    if (!inlineCtrl)
        return { ok: false, error: 'リプレイが実行されていません' };
    inlineCtrl.resume();
    addLog('再生再開');
    return { ok: true, state: 'playing' };
}
async function handleReplayStep() {
    if (!inlineCtrl)
        return { ok: false, error: 'リプレイが実行されていません' };
    inlineCtrl.step();
    addLog('1ステップ進めました');
    return { ok: true, state: 'stepped' };
}
async function handleReplayStop() {
    if (!inlineCtrl)
        return { ok: false, error: 'リプレイが実行されていません' };
    inlineCtrl.stop();
    // 停止後はidle状態に戻し、再度リプレイ開始できるようにする
    currentMode = 'idle';
    inlineCtrl = null;
    addLog('リプレイを停止しました');
    return { ok: true };
}
async function handleReplayBack() {
    if (!inlineCtrl)
        return { ok: false, error: 'リプレイが実行されていません' };
    const ok = await inlineCtrl.back();
    if (ok) {
        addLog('1ステップ戻りました');
        return { ok: true, state: 'rewound' };
    }
    return { ok: false, error: '先頭ラウンドのため戻れません' };
}
// ── 対戦モード API ──────────────────────────────────────────────────────────
async function handlePlayStart(body) {
    if (!bridgeClient)
        return { ok: false, error: '先にルームに接続してください' };
    if (currentMode !== 'idle')
        return { ok: false, error: `現在 ${currentMode} モードで実行中です` };
    const params = JSON.parse(body || '{}');
    const playerCount = Math.min(Math.max(params.playerCount ?? 3, 2), 5);
    const requestedStrategies = params.strategies ?? [];
    // 戦略バリデーション
    for (const sid of requestedStrategies) {
        if (!strategyIds.includes(sid)) {
            return { ok: false, error: `戦略 "${sid}" は存在しません。利用可能: ${strategyIds.join(', ')}` };
        }
    }
    // ボードをクリーン状態にリセット
    if (cleanBoardState) {
        bridgeClient.restoreState(cleanBoardState);
        bridgeClient.sendState();
        addLog('ボードを初期状態にリセットしました');
    }
    const ctrl = new PlayController(bridgeClient, {
        playerCount,
        aiStrategies: requestedStrategies,
        delay: params.delay ?? 1500,
    });
    playCtrl = ctrl;
    currentMode = 'play';
    addLog(`対戦モード開始 (${playerCount}人 / AI戦略: ${requestedStrategies.length > 0 ? requestedStrategies.join(', ') : 'ランダム'})`);
    ctrl.run().then(() => {
        addLog('対戦終了！');
        currentMode = 'idle';
        // keep playCtrl for final state query; will be cleared on next start
    }).catch((err) => {
        addLog(`対戦エラー: ${err.message}`);
        currentMode = 'idle';
        playCtrl = null;
    });
    return { ok: true };
}
async function handlePlaySelect(body) {
    if (!playCtrl)
        return { ok: false, error: '対戦が開始されていません' };
    const params = JSON.parse(body || '{}');
    const card = params.card;
    if (typeof card !== 'number')
        return { ok: false, error: 'card パラメータが必要です' };
    const accepted = playCtrl.setHumanSelection(card);
    if (!accepted) {
        return { ok: false, error: '現在あなたの番ではないか、そのカードは手札にありません' };
    }
    addLog(`カード ${card} を選択しました`);
    return { ok: true, card };
}
function handlePlayState() {
    if (!playCtrl) {
        return { ok: true, active: false };
    }
    const info = playCtrl.getGameInfo();
    return { ok: true, active: true, ...info };
}
async function handlePlayStop() {
    if (!playCtrl)
        return { ok: false, error: '対戦が開始されていません' };
    playCtrl.abort();
    playCtrl = null;
    currentMode = 'idle';
    addLog('対戦を中断しました');
    return { ok: true };
}
// ── 魔女ゲー API ──────────────────────────────────────────────────────────
async function handleMajoStart(body) {
    if (currentMode !== 'idle')
        return { ok: false, error: `現在 ${currentMode} モードで実行中です` };
    const params = JSON.parse(body || '{}');
    const requestedStrategies = params.strategies ?? [];
    // 戦略バリデーション
    for (const sid of requestedStrategies) {
        if (!majoStrategyIds.includes(sid)) {
            return { ok: false, error: `戦略 "${sid}" は存在しません。利用可能: ${majoStrategyIds.join(', ')}` };
        }
    }
    // ボード自動接続+セットアップ
    let boardSync = null;
    try {
        // 未接続なら自動接続
        if (!bridgeClient || !bridgeClient.isConnected()) {
            if (bridgeClient) {
                bridgeClient.disconnect();
            }
            addLog('ボード自動接続中...');
            bridgeClient = new BridgeClient({
                url: DEFAULT_BOARD_URL,
                playerName: 'AIブリッジ',
            });
            await Promise.race([
                bridgeClient.waitForState(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('接続タイムアウト')), 10000)),
            ]);
            currentRoomId = await bridgeClient.waitForRoomId();
            addLog(`ボード接続完了 (ルーム: ${currentRoomId})`);
        }
        // スプレッドシートでボードセットアップ
        const serverUrl = DEFAULT_BOARD_URL;
        const res = await fetch(`${serverUrl}/api/setup-game?id=${MAJO_SHEET_ID}&players=4`);
        const data = await res.json();
        if (data.ok && data.gameState) {
            const state = bridgeClient.getState();
            const gs = data.gameState;
            bridgeClient.restoreState({
                ...state,
                cardDefinitions: gs.cardDefinitions,
                areas: gs.areas,
                cardTemplates: gs.cardTemplates,
                cardInstances: gs.cardInstances,
                cardStacks: gs.cardStacks,
                counters: gs.counters,
                players: gs.players,
                counterDefs: gs.counterDefs,
            });
            bridgeClient.sendState();
            cleanBoardState = JSON.parse(JSON.stringify(bridgeClient.getState()));
            addLog('魔女ゲーボード自動セットアップ完了');
        }
        boardSync = new MajoBoardSync(bridgeClient);
    }
    catch (err) {
        addLog(`ボード接続/セットアップスキップ: ${err.message} — コントロールパネルのみで動作`);
    }
    const ctrl = new MajoPlayController({
        humanPlayerIndex: params.humanPlayerIndex ?? 0,
        aiStrategies: requestedStrategies,
        aiDelay: params.aiDelay ?? 800,
    });
    majoPlayCtrl = ctrl;
    currentMode = 'majo';
    // ボード同期セットアップ
    if (boardSync) {
        majoBoardSync = boardSync;
        boardSync.setController(ctrl);
        ctrl.setOnUpdate(() => {
            if (majoBoardSync && majoPlayCtrl) {
                majoBoardSync.sync(majoPlayCtrl.getGameInfo());
            }
        });
        await boardSync.init(ctrl.getGameInfo());
    }
    addLog(`魔女ゲー開始 (AI戦略: ${requestedStrategies.length > 0 ? requestedStrategies.join(', ') : 'ランダム'}${boardSync ? ', ボード連携ON' : ''})`);
    ctrl.run().then(() => {
        addLog('魔女ゲー終了！');
        if (majoBoardSync && majoPlayCtrl) {
            majoBoardSync.sync(majoPlayCtrl.getGameInfo());
        }
        if (majoBoardSync) {
            majoBoardSync.cleanup();
            majoBoardSync = null;
        }
        currentMode = 'idle';
    }).catch((err) => {
        addLog(`魔女ゲーエラー: ${err.message}`);
        if (majoBoardSync) {
            majoBoardSync.cleanup();
            majoBoardSync = null;
        }
        currentMode = 'idle';
        majoPlayCtrl = null;
    });
    return { ok: true, boardConnected: !!boardSync };
}
function handleMajoState() {
    if (!majoPlayCtrl) {
        return { ok: true, active: false };
    }
    const info = majoPlayCtrl.getGameInfo();
    return { ok: true, active: true, ...info };
}
async function handleMajoAction(body) {
    if (!majoPlayCtrl)
        return { ok: false, error: '魔女ゲーが開始されていません' };
    const params = JSON.parse(body || '{}');
    const index = params.index;
    if (typeof index !== 'number')
        return { ok: false, error: 'index パラメータが必要です' };
    const accepted = majoPlayCtrl.selectAction(index);
    if (!accepted) {
        return { ok: false, error: '現在あなたの番ではないか、無効なアクションです' };
    }
    addLog(`魔女ゲー: アクション ${index} を選択`);
    return { ok: true };
}
async function handleMajoStop() {
    if (!majoPlayCtrl)
        return { ok: false, error: '魔女ゲーが開始されていません' };
    majoPlayCtrl.abort();
    majoPlayCtrl = null;
    if (majoBoardSync) {
        majoBoardSync.cleanup();
        majoBoardSync = null;
    }
    currentMode = 'idle';
    addLog('魔女ゲーを中断しました');
    return { ok: true };
}
function handleStatus() {
    const strategyList = strategyIds.map((id) => ({
        id,
        name: strategies[id].name,
        description: strategies[id].description,
    }));
    const playInfo = playCtrl ? playCtrl.getGameInfo() : null;
    return {
        connected: bridgeClient?.isConnected() ?? false,
        roomId: currentRoomId,
        mode: currentMode,
        round: currentMode === 'play' ? (playInfo?.round ?? 0) : (inlineCtrl?.currentRound ?? 0),
        totalRounds: currentMode === 'play' ? (playInfo?.totalRounds ?? 0) : (inlineCtrl?.totalRounds ?? 0),
        paused: inlineCtrl?.isPaused ?? false,
        status: inlineCtrl?.statusMessage ?? '',
        roundResult: inlineCtrl?.roundResult ?? '',
        scores: currentMode === 'play' ? (playInfo?.scores ?? {}) : (inlineCtrl?.scores ?? {}),
        logs: logs.slice(-100),
        strategies: strategyList,
        replayLoaded: replayData !== null,
        replayInfo: replayData ? {
            gameName: replayData.gameName,
            rounds: replayData.rounds?.length ?? 0,
            players: replayData.players?.map((p) => ({ id: p.id, name: p.name })) ?? [],
        } : null,
        playInfo,
        majoActive: majoPlayCtrl !== null,
    };
}
// ── HTML コントロールパネル ────────────────────────────────────────────────────
function getHtml() {
    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ボドゲAI — コントロールパネル</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #111318;
    --surface: #1c2027;
    --surface2: #252b35;
    --border: #2e3540;
    --text: #e2e8f0;
    --text-muted: #7a8597;
    --accent: #4f8ef7;
    --accent-dark: #3a6fd8;
    --green: #34d399;
    --red: #f87171;
    --yellow: #fbbf24;
    --orange: #fb923c;
  }

  body {
    font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    font-size: 14px;
    line-height: 1.5;
  }

  header {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 14px 24px;
    display: flex;
    align-items: center;
    gap: 12px;
  }

  header h1 {
    font-size: 17px;
    font-weight: 700;
    letter-spacing: 0.02em;
  }

  header .badge {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--surface2);
    color: var(--text-muted);
    border: 1px solid var(--border);
  }

  .status-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--red);
    flex-shrink: 0;
  }
  .status-dot.connected { background: var(--green); box-shadow: 0 0 6px var(--green); }
  .status-dot.replay { background: var(--yellow); box-shadow: 0 0 6px var(--yellow); animation: pulse 1s ease-in-out infinite; }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .layout {
    display: flex;
    flex-direction: column;
    height: calc(100vh - 53px);
    overflow: hidden;
  }

  .top-area {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 10px;
    align-content: start;
  }

  .log-area {
    height: 200px;
    min-height: 120px;
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
  }

  .section {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: visible;
    flex-shrink: 0;
  }

  .section-header {
    padding: 8px 12px;
    font-weight: 600;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border);
    background: rgba(255,255,255,0.02);
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .section-body {
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  label {
    font-size: 12px;
    color: var(--text-muted);
    display: block;
    margin-bottom: 4px;
  }

  input[type="text"], input[type="url"], input[type="number"] {
    width: 100%;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 7px 10px;
    color: var(--text);
    font-size: 13px;
    outline: none;
    transition: border-color 0.15s;
  }
  input:focus { border-color: var(--accent); }

  input[type="range"] {
    width: 100%;
    accent-color: var(--accent);
  }

  select {
    width: 100%;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 7px 10px;
    color: var(--text);
    font-size: 13px;
    outline: none;
    transition: border-color 0.15s;
    cursor: pointer;
  }
  select:focus { border-color: var(--accent); }

  .btn {
    padding: 7px 14px;
    border: none;
    border-radius: 5px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.15s, background 0.15s;
    white-space: nowrap;
  }
  .btn:disabled { opacity: 0.35; cursor: not-allowed; }
  .btn-primary { background: var(--accent); color: #fff; }
  .btn-primary:hover:not(:disabled) { background: var(--accent-dark); }
  .btn-danger { background: #b91c1c; color: #fff; }
  .btn-danger:hover:not(:disabled) { background: #991b1b; }
  .btn-ghost { background: var(--surface); border: 1px solid var(--border); color: var(--text); }
  .btn-ghost:hover:not(:disabled) { background: var(--border); }
  .btn-success { background: #065f46; border: 1px solid #059669; color: var(--green); }
  .btn-success:hover:not(:disabled) { background: #047857; }

  .btn-row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .file-upload-area {
    border: 2px dashed var(--border);
    border-radius: 6px;
    padding: 16px;
    text-align: center;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
    color: var(--text-muted);
    font-size: 13px;
  }
  .file-upload-area:hover { border-color: var(--accent); background: rgba(79,142,247,0.05); }
  .file-upload-area.loaded { border-color: var(--green); color: var(--green); background: rgba(52,211,153,0.05); }

  .progress-bar-bg {
    width: 100%;
    height: 6px;
    background: var(--bg);
    border-radius: 3px;
    overflow: hidden;
  }
  .progress-bar-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 3px;
    transition: width 0.3s ease;
  }

  .progress-text {
    font-size: 12px;
    color: var(--text-muted);
    text-align: center;
  }

  .score-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .score-table th {
    text-align: left;
    padding: 6px 8px;
    color: var(--text-muted);
    font-weight: 500;
    font-size: 11px;
    border-bottom: 1px solid var(--border);
  }
  .score-table td {
    padding: 6px 8px;
    border-bottom: 1px solid rgba(46,53,64,0.5);
  }
  .score-table tr:last-child td { border-bottom: none; }
  .score-positive { color: var(--green); font-weight: 600; }
  .score-negative { color: var(--red); font-weight: 600; }

  .log-header {
    padding: 6px 12px;
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
  }

  .log-body {
    flex: 1;
    overflow-y: auto;
    padding: 6px 12px;
    font-family: 'Consolas', 'Cascadia Code', monospace;
    font-size: 11px;
    color: var(--text-muted);
    background: var(--bg);
    line-height: 1.6;
  }

  .log-entry { padding: 0; }
  .log-entry .ts { color: #3e4a5c; }
  .log-entry .msg { color: var(--text); }

  .status-chip {
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
  }
  .chip-idle { background: rgba(122,133,151,0.2); color: var(--text-muted); }
  .chip-replay { background: rgba(251,191,36,0.2); color: var(--yellow); }
  .chip-connected { background: rgba(52,211,153,0.15); color: var(--green); }
  .chip-disconnected { background: rgba(248,113,113,0.15); color: var(--red); }

  .room-id-display {
    font-family: monospace;
    font-size: 11px;
    color: var(--accent);
    background: rgba(79,142,247,0.1);
    padding: 2px 8px;
    border-radius: 4px;
    border: 1px solid rgba(79,142,247,0.2);
  }

  .delay-label {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .info-text {
    font-size: 11px;
    color: var(--text-muted);
    font-style: italic;
  }

  .copy-btn {
    padding: 2px 8px;
    font-size: 11px;
    font-weight: 600;
    border: 1px solid rgba(79,142,247,0.4);
    border-radius: 4px;
    background: rgba(79,142,247,0.1);
    color: var(--accent);
    cursor: pointer;
    transition: background 0.15s;
    white-space: nowrap;
  }
  .copy-btn:hover { background: rgba(79,142,247,0.25); }
  .copy-btn.copied { background: rgba(52,211,153,0.15); color: var(--green); border-color: rgba(52,211,153,0.4); }

  .room-id-box {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    background: rgba(79,142,247,0.07);
    border: 1px solid rgba(79,142,247,0.2);
    border-radius: 6px;
  }

  .room-id-label {
    font-size: 11px;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .hint-text {
    font-size: 11px;
    color: var(--text-muted);
    background: rgba(122,133,151,0.08);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 6px 10px;
  }

  .generate-result {
    font-size: 11px;
    color: var(--green);
    background: rgba(52,211,153,0.08);
    border: 1px solid rgba(52,211,153,0.2);
    border-radius: 5px;
    padding: 8px 10px;
    display: none;
  }

  .generate-result.visible { display: block; }

  .strategy-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }

  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: #3e4a5c; }

  /* 対戦モード */
  .hand-area {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    min-height: 40px;
    padding: 6px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    align-items: center;
  }

  .card-btn {
    width: 40px;
    height: 52px;
    border: 2px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
    font-size: 15px;
    font-weight: 700;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s, transform 0.1s;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .card-btn:hover { background: var(--accent); border-color: var(--accent); transform: translateY(-3px); }
  .card-btn.negative { color: var(--red); }
  .card-btn.positive { color: var(--green); }

  .play-status-box {
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
    text-align: center;
  }
  .play-status-waiting { background: rgba(251,191,36,0.15); border: 1px solid rgba(251,191,36,0.3); color: var(--yellow); }
  .play-status-thinking { background: rgba(79,142,247,0.12); border: 1px solid rgba(79,142,247,0.25); color: var(--accent); }
  .play-status-idle { background: rgba(122,133,151,0.1); border: 1px solid var(--border); color: var(--text-muted); }
  .play-status-finished { background: rgba(52,211,153,0.1); border: 1px solid rgba(52,211,153,0.25); color: var(--green); }

  .point-card-display {
    font-size: 28px;
    font-weight: 800;
    text-align: center;
    padding: 8px;
  }
  .point-positive { color: var(--green); }
  .point-negative { color: var(--red); }

  .chip-play { background: rgba(251,191,36,0.2); color: var(--yellow); }
  .chip-majo { background: rgba(168,85,247,0.2); color: #c084fc; }

  /* 魔女ゲー専用スタイル */
  .majo-supply { display: flex; flex-wrap: wrap; gap: 6px; }
  .majo-card {
    background: var(--surface2); border: 1px solid var(--border); border-radius: 6px;
    padding: 6px 8px; font-size: 11px; line-height: 1.4; min-width: 140px; flex: 1;
  }
  .majo-card-name { font-weight: 700; font-size: 12px; }
  .majo-card-detail { color: var(--text-muted); font-size: 10px; }
  .majo-field { display: flex; flex-wrap: wrap; gap: 4px; }
  .majo-field-slot {
    background: var(--surface2); border: 1px solid var(--border); border-radius: 4px;
    padding: 4px 8px; font-size: 11px;
  }
  .majo-field-slot.full { opacity: 0.5; }
  .majo-player {
    background: var(--surface2); border: 1px solid var(--border); border-radius: 6px;
    padding: 8px 10px; margin-bottom: 6px; font-size: 12px;
  }
  .majo-player.is-human { border-color: var(--accent); }
  .majo-player.is-current { box-shadow: 0 0 8px rgba(79,142,247,0.3); }
  .majo-player-header { display: flex; justify-content: space-between; font-weight: 700; margin-bottom: 4px; }
  .majo-player-stats { color: var(--text-muted); font-size: 11px; }
  .majo-player-items { color: var(--text-muted); font-size: 10px; margin-top: 3px; }
  .majo-actions { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
  .majo-action-btn {
    background: var(--surface2); border: 1px solid var(--border); border-radius: 6px;
    padding: 8px 12px; font-size: 12px; color: var(--text); cursor: pointer;
    text-align: left; transition: all 0.15s;
  }
  .majo-action-btn:hover { border-color: var(--accent); background: rgba(79,142,247,0.08); }
  .majo-action-btn.cat-field { border-left: 3px solid var(--accent); }
  .majo-action-btn.cat-relic { border-left: 3px solid var(--orange); }
  .majo-action-btn.cat-witch { border-left: 3px solid #c084fc; }
  .majo-action-btn.cat-extra_combat { border-left: 3px solid var(--red); }
  .majo-action-btn.cat-pass { border-left: 3px solid var(--text-muted); }
</style>
</head>
<body>

<header>
  <div class="status-dot" id="connDot"></div>
  <h1>ボドゲAI — コントロールパネル</h1>
  <span class="badge" id="modeBadge">アイドル</span>
</header>

<div class="layout">
  <!-- 操作エリア -->
  <div class="top-area">

    <!-- 接続セクション -->
    <div class="section">
      <div class="section-header">
        <span>🔌</span> サーバー接続
      </div>
      <div class="section-body">
        <details style="margin-bottom:6px">
          <summary style="font-size:11px;color:var(--text-muted);cursor:pointer">詳細設定</summary>
          <div style="margin-top:6px">
            <label>サーバーURL</label>
            <input type="text" id="boardUrl" value="http://localhost:3210" placeholder="http://localhost:3210" />
          </div>
        </details>
        <div>
          <label>ルームID（空欄で新規作成）</label>
          <input type="text" id="roomId" placeholder="例: hagetaka-bridge" />
        </div>
        <div class="btn-row">
          <button class="btn btn-primary" id="btnConnect">接続</button>
          <button class="btn btn-ghost" id="btnDisconnect" disabled>切断</button>
        </div>
        <div id="roomDisplay" style="display:none">
          <div class="room-id-box" style="cursor:pointer" onclick="copyRoomId()" title="クリックでコピー">
            <span class="room-id-label">ルームID:</span>
            <span class="room-id-display" id="roomIdDisplay"></span>
            <span id="copyFeedback" style="font-size:11px;color:var(--green);display:none">✓ コピー済</span>
          </div>
          <a id="boardLink" href="#" target="_blank" style="display:block;margin-top:6px;padding:8px 12px;background:var(--green);color:#fff;text-align:center;border-radius:6px;text-decoration:none;font-weight:600;font-size:13px">🎮 ボードを開く（観戦モード）</a>
        </div>
      </div>
    </div>

    <!-- ゲーム設定セクション -->
    <div class="section">
      <div class="section-header">
        <span>🎲</span> ゲーム設定
      </div>
      <div class="section-body">
        <div>
          <label>スプレッドシートURL</label>
          <input type="text" id="sheetUrl" placeholder="https://docs.google.com/spreadsheets/d/..." />
        </div>
        <div>
          <label>プレイヤー数</label>
          <select id="setupPlayerCount">
            <option value="2">2人</option>
            <option value="3" selected>3人</option>
            <option value="4">4人</option>
            <option value="5">5人</option>
          </select>
        </div>
      </div>
    </div>

    <!-- リプレイセクション -->
    <div class="section">
      <div class="section-header">
        <span>▶</span> リプレイ
      </div>
      <div class="section-body">
        <div>
          <label>リプレイJSON</label>
          <div class="file-upload-area" id="uploadArea" onclick="document.getElementById('fileInput').click()">
            <div>📁 クリックしてJSONを選択</div>
            <div style="font-size:11px;margin-top:4px">またはここにドラッグ＆ドロップ</div>
          </div>
          <input type="file" id="fileInput" accept=".json" style="display:none" />
        </div>

        <div>
          <div class="delay-label">
            <label>再生速度（ディレイ）</label>
            <span id="delayValue" style="font-size:12px;color:var(--accent)">2000ms</span>
          </div>
          <input type="range" id="delaySlider" min="300" max="6000" step="100" value="2000" />
        </div>

        <button class="btn btn-primary" id="btnReplayStart" disabled>▶ リプレイ開始</button>

        <div class="btn-row">
          <button class="btn btn-ghost" id="btnBack" disabled>◀ 戻る</button>
          <button class="btn btn-ghost" id="btnStep" disabled>進む ▶</button>
          <button class="btn btn-ghost" id="btnResume" disabled>オート</button>
          <button class="btn btn-ghost" id="btnPause" disabled>⏸ 一時停止</button>
          <button class="btn btn-danger" id="btnStop" disabled>⏹ 停止</button>
        </div>

        <div>
          <div class="progress-bar-bg">
            <div class="progress-bar-fill" id="progressBar" style="width:0%"></div>
          </div>
          <div class="progress-text" id="progressText">— / —</div>
        </div>

        <div id="roundResult" style="display:none;font-size:22px;font-weight:700;text-align:center;padding:14px 10px;background:rgba(79,142,247,0.1);border:1px solid rgba(79,142,247,0.25);border-radius:8px;color:var(--text)"></div>

        <div id="currentStatus" class="info-text" style="min-height:18px;padding:6px 0;font-size:12px"></div>
      </div>
    </div>

    <!-- スコアセクション -->
    <div class="section">
      <div class="section-header">
        <span>🏆</span> スコア
      </div>
      <div class="section-body" style="padding: 10px 0 0 0">
        <table class="score-table">
          <thead>
            <tr>
              <th>プレイヤー</th>
              <th>スロット</th>
              <th>スコア</th>
            </tr>
          </thead>
          <tbody id="scoreBody">
            <tr><td colspan="3" style="text-align:center;color:var(--text-muted);padding:12px">データなし</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- AI対戦セクション -->
    <div class="section">
      <div class="section-header">
        <span>🤖</span> AI対戦を生成
      </div>
      <div class="section-body">
        <div>
          <label>プレイヤー数</label>
          <select id="genPlayerCount">
            <option value="2">2人</option>
            <option value="3" selected>3人</option>
            <option value="4">4人</option>
            <option value="5">5人</option>
          </select>
        </div>

        <div>
          <label>戦略（省略でランダム）</label>
          <div class="strategy-grid" id="strategySelects">
            <!-- JS で動的生成 -->
          </div>
        </div>

        <div class="btn-row">
          <button class="btn btn-success" id="btnGenerate">🤖 生成</button>
          <button class="btn btn-primary" id="btnGenerateAndStart">🚀 生成→再生</button>
        </div>

        <div class="generate-result" id="generateResult"></div>
      </div>
    </div>

    <!-- 対戦モードセクション -->
    <div class="section">
      <div class="section-header">
        <span>🎮</span> 対戦モード（人間 vs AI）
      </div>
      <div class="section-body">
        <div>
          <label>プレイヤー数（あなた + AI）</label>
          <select id="playPlayerCount">
            <option value="2">2人（あなた + AI×1）</option>
            <option value="3" selected>3人（あなた + AI×2）</option>
            <option value="4">4人（あなた + AI×3）</option>
            <option value="5">5人（あなた + AI×4）</option>
          </select>
        </div>

        <div>
          <label>AI戦略（省略でランダム）</label>
          <div class="strategy-grid" id="playStrategySelects">
            <!-- JS で動的生成 -->
          </div>
        </div>

        <div class="btn-row">
          <button class="btn btn-primary" id="btnPlayStart">🎮 対戦開始</button>
          <button class="btn btn-danger" id="btnPlayStop" disabled>⏹ 中断</button>
        </div>

        <div id="playStatusBox" class="play-status-box play-status-idle">待機中</div>

        <div id="playPointArea" style="display:none">
          <label>得点カード</label>
          <div class="point-card-display" id="playPointCard">—</div>
          <div id="playCarryOver" style="font-size:11px;color:var(--text-muted);text-align:center"></div>
        </div>

        <div id="playHandArea" style="display:none">
          <label>あなたの手札（クリックで選択）</label>
          <div class="hand-area" id="playHand"></div>
        </div>

        <div id="playRoundResult" style="display:none;font-size:13px;padding:8px 10px;background:rgba(79,142,247,0.08);border:1px solid rgba(79,142,247,0.2);border-radius:6px;color:var(--text);text-align:center"></div>
      </div>
    </div>

    <!-- 魔女ゲーセクション -->
    <div class="section">
      <div class="section-header">
        <span>🧙</span> 魔女ゲー（人間 vs AI×3）
      </div>
      <div class="section-body">
        <div>
          <label>AI戦略（省略でランダム）</label>
          <div class="strategy-grid" id="majoStrategySelects"></div>
        </div>

        <div class="btn-row">
          <button class="btn btn-primary" id="btnMajoStart">🧙 魔女ゲー開始</button>
          <button class="btn btn-danger" id="btnMajoStop" disabled>⏹ 中断</button>
        </div>

        <div id="majoStatusBox" class="play-status-box play-status-idle">待機中</div>

        <!-- ゲーム盤面 -->
        <div id="majoBoardArea" style="display:none">
          <!-- ラウンド＆ターン表示 -->
          <div id="majoRoundInfo" style="text-align:center;font-weight:bold;margin-bottom:8px"></div>

          <!-- サプライエリア -->
          <div style="margin-bottom:10px">
            <label>🗡 魔導具展示</label>
            <div id="majoToolSupply" class="majo-supply"></div>
          </div>
          <div style="margin-bottom:10px">
            <label>⚔ 聖者展示</label>
            <div id="majoSaintSupply" class="majo-supply"></div>
          </div>
          <div style="margin-bottom:10px;font-size:12px;color:var(--text-muted)">
            聖遺物デッキ: <span id="majoRelicDeckCount">0</span>枚 ／
            魔導具デッキ: <span id="majoToolDeckCount">0</span>枚 ／
            聖者デッキ: <span id="majoSaintDeckCount">0</span>枚
          </div>

          <!-- フィールド -->
          <div style="margin-bottom:10px">
            <label>📍 フィールド</label>
            <div id="majoFieldActions" class="majo-field"></div>
          </div>

          <!-- プレイヤー情報 -->
          <div id="majoPlayers" style="margin-bottom:10px"></div>

          <!-- アクション選択 -->
          <div id="majoActionArea" style="display:none">
            <label>🎮 あなたのターン — アクションを選択</label>
            <div id="majoActions" class="majo-actions"></div>
          </div>

          <!-- イベントログ -->
          <div id="majoEventLog" style="margin-top:8px;font-size:12px;color:var(--text-muted)"></div>
        </div>
      </div>
    </div>

  </div>

  <!-- ログエリア（下部固定高） -->
  <div class="log-area">
    <div class="log-header">
      <div style="display:flex;align-items:center;gap:12px">
        <span>📋 ログ</span>
        <span class="status-chip" id="connChip">未接続</span>
        <span class="status-chip chip-idle" id="modeChip">アイドル</span>
        <span id="roundChip" style="font-size:11px"></span>
      </div>
      <button class="btn btn-ghost" style="padding:2px 8px;font-size:11px" onclick="clearLogs()">クリア</button>
    </div>
    <div class="log-body" id="logBody">
      <div class="log-entry" style="color:var(--text-muted)">— ブリッジコントロールパネルが起動しました —</div>
    </div>
  </div>
</div>

<script>
  // ── 状態 ──────────────────────────────────────────────────────────────────
  let isConnected = false;
  let currentMode = 'idle';
  let isReplayRunning = false;
  let lastLogCount = 0;
  let replayLoaded = false;
  let pollInterval = null;
  let replayInfo = null;

  // スプシURLをlocalStorageから復元
  const savedSheetUrl = localStorage.getItem('bridgeSheetUrl') || '';
  document.addEventListener('DOMContentLoaded', () => {
    const el = document.getElementById('sheetUrl');
    if (el && savedSheetUrl) el.value = savedSheetUrl;
  });
  // 変更時に保存
  document.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'sheetUrl') {
      localStorage.setItem('bridgeSheetUrl', e.target.value);
    }
  });

  // 利用可能な戦略一覧
  const STRATEGIES = ['balanced', 'aggressive', 'conservative', 'counter', 'chaotic', 'economist'];
  const STRATEGY_LABELS = {
    balanced: 'バランス型',
    aggressive: '攻撃型',
    conservative: '慎重型',
    counter: 'カウンター型',
    chaotic: '混沌型',
    economist: '経済学者型',
  };

  // ── 戦略セレクト初期化 ──────────────────────────────────────────────────────
  function buildStrategySelects(count) {
    const container = document.getElementById('strategySelects');
    container.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const sel = document.createElement('select');
      sel.id = 'stratSel_' + i;
      sel.style.fontSize = '12px';
      const randomOpt = document.createElement('option');
      randomOpt.value = '';
      randomOpt.textContent = 'ランダム';
      sel.appendChild(randomOpt);
      for (const sid of STRATEGIES) {
        const opt = document.createElement('option');
        opt.value = sid;
        opt.textContent = STRATEGY_LABELS[sid] || sid;
        sel.appendChild(opt);
      }
      container.appendChild(sel);
    }
  }

  buildStrategySelects(3);

  document.getElementById('genPlayerCount').addEventListener('change', function() {
    buildStrategySelects(parseInt(this.value));
  });

  // ── ユーティリティ ─────────────────────────────────────────────────────────
  async function api(path, body) {
    const opts = body !== undefined
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { method: 'GET' };
    const res = await fetch(path, opts);
    return res.json();
  }

  function toast(msg, type = 'info') {
    addLogEntry(msg);
  }

  function clearLogs() {
    document.getElementById('logBody').innerHTML =
      '<div class="log-entry" style="color:var(--text-muted)">— ログをクリアしました —</div>';
    lastLogCount = 0;
  }

  function copyRoomId() {
    const id = document.getElementById('roomIdDisplay').textContent;
    navigator.clipboard.writeText(id).then(() => {
      const fb = document.getElementById('copyFeedback');
      fb.style.display = 'inline';
      setTimeout(() => { fb.style.display = 'none'; }, 1500);
    });
  }

  function addLogEntry(msg) {
    const body = document.getElementById('logBody');
    const wasAtBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 30;
    const el = document.createElement('div');
    el.className = 'log-entry';
    el.textContent = msg;
    body.appendChild(el);
    if (wasAtBottom) body.scrollTop = body.scrollHeight;
  }

  // ── ステータスポーリング ────────────────────────────────────────────────────
  async function fetchStatus() {
    try {
      const s = await api('/api/status');
      updateUI(s);
    } catch (e) {
      // サーバー接続中は無視
    }
  }

  function updateUI(s) {
    // 接続状態
    isConnected = s.connected;
    const dot = document.getElementById('connDot');
    dot.className = 'status-dot' + (s.connected ? ' connected' : '');

    const connChip = document.getElementById('connChip');
    connChip.textContent = s.connected ? '接続中' : '未接続';
    connChip.className = 'status-chip ' + (s.connected ? 'chip-connected' : 'chip-disconnected');

    // ルームID
    if (s.roomId) {
      document.getElementById('roomDisplay').style.display = 'block';
      document.getElementById('roomIdDisplay').textContent = s.roomId;
      // playモード=プレイヤー参加（カード操作必要）、それ以外（majo含む）=観戦モード
      const boardMode = s.mode === 'play' ? 'join' : 'spectate';
      document.getElementById('boardLink').href = 'http://localhost:3210/?' + boardMode + '=' + s.roomId;
      document.getElementById('boardLink').textContent = s.mode === 'play'
        ? '🎮 ボードを開く（プレイヤー参加）'
        : '🎮 ボードを開く（観戦モード）';
    } else {
      document.getElementById('roomDisplay').style.display = 'none';
    }

    // モード
    currentMode = s.mode;
    isReplayRunning = s.mode === 'replay';
    const modeBadge = document.getElementById('modeBadge');
    const modeChip = document.getElementById('modeChip');
    const modeLabel = { idle: 'アイドル', replay: 'リプレイ中', play: '対戦中', majo: '魔女ゲー中' }[s.mode] || s.mode;
    modeBadge.textContent = modeLabel;
    modeChip.textContent = modeLabel;
    const modeChipClass = s.mode === 'idle' ? 'chip-idle' : s.mode === 'play' ? 'chip-play' : s.mode === 'majo' ? 'chip-majo' : 'chip-replay';
    modeChip.className = 'status-chip ' + modeChipClass;
    const dot2 = document.getElementById('connDot');
    if (s.mode === 'replay' || s.mode === 'play' || s.mode === 'majo') dot2.className = 'status-dot replay';

    // リプレイ情報
    replayLoaded = s.replayLoaded;
    if (s.replayInfo) {
      replayInfo = s.replayInfo;
      const area = document.getElementById('uploadArea');
      area.className = 'file-upload-area loaded';
      area.innerHTML = '<div>✅ ' + s.replayInfo.gameName + '</div>' +
        '<div style="font-size:11px;margin-top:4px">' + s.replayInfo.rounds + 'ラウンド / ' +
        s.replayInfo.players.map(p => p.name).join(', ') + '</div>';
    }

    // プログレス
    if (s.totalRounds > 0) {
      const pct = (s.round / s.totalRounds) * 100;
      document.getElementById('progressBar').style.width = pct + '%';
      document.getElementById('progressText').textContent = 'ラウンド ' + s.round + ' / ' + s.totalRounds;
    } else {
      document.getElementById('progressBar').style.width = '0%';
      document.getElementById('progressText').textContent = '— / —';
    }

    // 現在のステータス
    document.getElementById('currentStatus').textContent = s.status || '';

    // ラウンドチップ
    const roundChip = document.getElementById('roundChip');
    if (s.mode === 'replay' && s.totalRounds > 0) {
      roundChip.textContent = 'ラウンド ' + s.round + ' / ' + s.totalRounds + (s.paused ? ' ⏸' : ' ▶');
      roundChip.style.display = '';
    } else {
      roundChip.textContent = '';
    }

    // ログの差分更新
    if (s.logs && s.logs.length > 0) {
      const body = document.getElementById('logBody');
      const wasAtBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 30;
      const newEntries = s.logs.slice(lastLogCount > s.logs.length ? 0 : lastLogCount);
      for (const entry of newEntries) {
        const el = document.createElement('div');
        el.className = 'log-entry';
        const m = entry.match(/^(\\[.*?\\])\\s(.*)$/);
        if (m) {
          el.innerHTML = '<span class="ts">' + m[1] + '</span> <span class="msg">' + escHtml(m[2]) + '</span>';
        } else {
          el.textContent = entry;
        }
        body.appendChild(el);
      }
      lastLogCount = s.logs.length;
      if (wasAtBottom) body.scrollTop = body.scrollHeight;
    }

    // ラウンド結果表示
    const roundResultEl = document.getElementById('roundResult');
    if (s.roundResult) {
      roundResultEl.textContent = s.roundResult;
      roundResultEl.style.display = 'block';
    } else {
      roundResultEl.style.display = 'none';
    }

    // スコア表示
    updateScores(s);

    // ボタン状態の更新
    updateButtons(s);

    // 対戦モードUI更新
    if (typeof updatePlayUI === 'function') updatePlayUI(s);
    // 魔女ゲーUI更新
    if (typeof updateMajoUI === 'function') updateMajoUI(s);

    // ラウンドチップ: 対戦モードでも表示
    if (s.mode === 'play' && s.totalRounds > 0) {
      const roundChip = document.getElementById('roundChip');
      roundChip.textContent = 'ラウンド ' + s.round + ' / ' + s.totalRounds;
      roundChip.style.display = '';
    }
  }

  function escHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function updateScores(s) {
    const tbody = document.getElementById('scoreBody');
    const scores = s.scores || {};
    const slots = Object.keys(scores);

    if (slots.length === 0) {
      if (!s.replayInfo) {
        tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--text-muted);padding:12px">データなし</td></tr>';
        return;
      }
      if (s.replayInfo) {
        const slotNames = ['p0','p1','p2','p3','p4'];
        tbody.innerHTML = s.replayInfo.players.map((p, i) =>
          '<tr><td>' + escHtml(p.name) + '</td><td style="color:var(--text-muted)">' + slotNames[i] + '</td>' +
          '<td class="score-positive">—</td></tr>'
        ).join('');
      }
      return;
    }

    const slotToPlayer = {};
    if (s.replayInfo) {
      const slotNames = ['p0','p1','p2','p3','p4'];
      s.replayInfo.players.forEach((p, i) => {
        slotToPlayer[slotNames[i]] = p.name;
      });
    }

    const sorted = slots.sort((a, b) => (scores[b] || 0) - (scores[a] || 0));
    tbody.innerHTML = sorted.map((slot) => {
      const score = scores[slot] || 0;
      const cls = score > 0 ? 'score-positive' : score < 0 ? 'score-negative' : '';
      const name = slotToPlayer[slot] || slot;
      return '<tr><td>' + escHtml(name) + '</td><td style="color:var(--text-muted)">' + slot + '</td>' +
        '<td class="' + cls + '">' + (score > 0 ? '+' : '') + score + '点</td></tr>';
    }).join('');
  }

  function updateButtons(s) {
    const connected = s.connected;
    const idle = s.mode === 'idle';
    const running = s.mode === 'replay';
    const paused = s.paused;

    document.getElementById('btnConnect').disabled = connected;
    document.getElementById('btnDisconnect').disabled = !connected;
    document.getElementById('btnReplayStart').disabled = !connected || !replayLoaded || !idle;
    document.getElementById('btnBack').disabled = !running;
    document.getElementById('btnPause').disabled = !running || paused;
    document.getElementById('btnResume').disabled = !running || !paused;
    document.getElementById('btnStep').disabled = !running;
    document.getElementById('btnStop').disabled = !running;
  }

  // ── アクション ─────────────────────────────────────────────────────────────
  document.getElementById('btnConnect').addEventListener('click', async () => {
    const boardUrl = document.getElementById('boardUrl').value.trim();
    const roomId = document.getElementById('roomId').value.trim();
    document.getElementById('btnConnect').disabled = true;
    document.getElementById('btnConnect').textContent = '接続中...';
    try {
      const r = await api('/api/connect', { boardUrl, roomId: roomId || undefined });
      if (r.ok) {
        toast('接続成功！ルームID: ' + r.roomId);
        localStorage.setItem('bridgeRoomId', r.roomId);
      } else {
        toast('接続失敗: ' + (r.error || '不明なエラー'));
      }
    } catch (e) {
      toast('接続エラー: ' + e.message);
    } finally {
      document.getElementById('btnConnect').textContent = '接続';
      fetchStatus();
    }
  });

  document.getElementById('btnDisconnect').addEventListener('click', async () => {
    await api('/api/disconnect', {});
    localStorage.removeItem('bridgeRoomId');
    toast('切断しました');
    fetchStatus();
  });

  document.getElementById('btnReplayStart').addEventListener('click', async () => {
    const delay = parseInt(document.getElementById('delaySlider').value);
    const r = await api('/api/replay/start', { delay });
    if (!r.ok) toast('エラー: ' + r.error);
    lastLogCount = 0;
    fetchStatus();
  });

  document.getElementById('btnBack').addEventListener('click', async () => {
    const r = await api('/api/replay/back', {});
    if (!r.ok) toast('戻れません: ' + (r.error || '先頭ラウンドです'));
    fetchStatus();
  });

  document.getElementById('btnPause').addEventListener('click', async () => {
    await api('/api/replay/pause', {});
    fetchStatus();
  });

  document.getElementById('btnResume').addEventListener('click', async () => {
    await api('/api/replay/resume', {});
    fetchStatus();
  });

  document.getElementById('btnStep').addEventListener('click', async () => {
    await api('/api/replay/step', {});
    fetchStatus();
  });

  document.getElementById('btnStop').addEventListener('click', async () => {
    await api('/api/replay/stop', {});
    fetchStatus();
  });

  // ── AI対戦生成 ─────────────────────────────────────────────────────────────
  document.getElementById('btnGenerate').addEventListener('click', async () => {
    const btn = document.getElementById('btnGenerate');
    const resultEl = document.getElementById('generateResult');
    btn.disabled = true;
    btn.textContent = '⏳ 生成中...';
    resultEl.className = 'generate-result';

    try {
      const playerCount = parseInt(document.getElementById('genPlayerCount').value);
      const strategies = [];
      for (let i = 0; i < playerCount; i++) {
        const sel = document.getElementById('stratSel_' + i);
        if (sel && sel.value) strategies.push(sel.value);
      }

      const r = await api('/api/replay/generate', {
        players: playerCount,
        strategies: strategies.length > 0 ? strategies : undefined,
      });

      if (r.ok) {
        toast('AI対戦生成完了！' + r.players.join(' vs ') + ' (' + r.rounds + 'ラウンド)');
        replayLoaded = true;
        lastLogCount = 0;

        // 結果表示
        const winner = r.finalScores && r.finalScores.find(s => s.rank === 1);
        const medals = ['🥇','🥈','🥉'];
        let html = '<strong>生成完了</strong> — ' + r.rounds + 'ラウンド<br>';
        html += '<span style="color:var(--text-muted)">' + r.strategies.join(' / ') + '</span><br><br>';
        if (r.finalScores) {
          html += r.finalScores.map((s, i) => {
            const medal = medals[i] || '';
            const scoreStr = s.score >= 0 ? '+' + s.score : '' + s.score;
            return medal + ' ' + escHtml(s.name) + ' <strong>' + scoreStr + '点</strong>';
          }).join('<br>');
        }
        resultEl.innerHTML = html;
        resultEl.className = 'generate-result visible';

        fetchStatus();
      } else {
        toast('生成エラー: ' + (r.error || '不明'));
        resultEl.innerHTML = '❌ ' + escHtml(r.error || '生成に失敗しました');
        resultEl.className = 'generate-result visible';
        resultEl.style.color = 'var(--red)';
        resultEl.style.background = 'rgba(248,113,113,0.08)';
        resultEl.style.borderColor = 'rgba(248,113,113,0.2)';
      }
    } catch (e) {
      toast('生成エラー: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '🤖 生成';
    }
  });

  // 「生成→再生」ワンクリックボタン
  // 「生成→再生」全自動フロー: 接続→セットアップ→AI生成→リプレイ開始
  document.getElementById('btnGenerateAndStart').addEventListener('click', async () => {
    const btn = document.getElementById('btnGenerateAndStart');
    const resultEl = document.getElementById('generateResult');
    btn.disabled = true;
    resultEl.className = 'generate-result';

    try {
      const sheetUrl = document.getElementById('sheetUrl').value.trim();
      const setupPlayerCount = parseInt(document.getElementById('setupPlayerCount').value);
      const genPlayerCount = parseInt(document.getElementById('genPlayerCount').value);
      const delay = parseInt(document.getElementById('delaySlider').value);
      const strategies = [];
      for (let i = 0; i < genPlayerCount; i++) {
        const sel = document.getElementById('stratSel_' + i);
        if (sel && sel.value) strategies.push(sel.value);
      }

      // Step 1: 未接続なら接続
      if (!isConnected) {
        btn.textContent = '⏳ 接続中...';
        const boardUrl = document.getElementById('boardUrl').value.trim();
        const roomId = document.getElementById('roomId').value.trim();
        const connR = await api('/api/connect', { boardUrl, roomId: roomId || undefined });
        if (!connR.ok) throw new Error('接続失敗: ' + (connR.error || ''));
        localStorage.setItem('bridgeRoomId', connR.roomId);
        toast('接続成功: ' + connR.roomId);
        await fetchStatus();
      }

      // Step 2: スプシURLがあればセットアップ
      if (sheetUrl) {
        btn.textContent = '⏳ ゲーム設定中...';
        const setupR = await api('/api/setup-board', { sheetUrl, playerCount: setupPlayerCount });
        if (!setupR.ok) throw new Error('セットアップ失敗: ' + (setupR.error || ''));
        toast('ゲーム設定完了');
      }

      // Step 3: AI対戦生成
      btn.textContent = '⏳ AI対戦生成中...';
      const genR = await api('/api/replay/generate', {
        players: genPlayerCount,
        strategies: strategies.length > 0 ? strategies : undefined,
      });
      if (!genR.ok) throw new Error('生成失敗: ' + (genR.error || ''));
      replayLoaded = true;
      lastLogCount = 0;

      // Step 4: リプレイ開始
      btn.textContent = '⏳ リプレイ開始...';
      const startR = await api('/api/replay/start', { delay });
      if (!startR.ok) throw new Error('リプレイ開始失敗: ' + (startR.error || ''));

      let html = '<strong>✅ 全自動完了</strong><br>';
      html += '<span style="color:var(--text-muted)">' + (genR.strategies || []).join(' / ') + '</span>';
      resultEl.innerHTML = html;
      resultEl.className = 'generate-result visible';
      toast('全自動完了！リプレイ開始（一時停止状態）');

      // ボードを自動で開く
      await fetchStatus();
      const boardLinkEl = document.getElementById('boardLink');
      if (boardLinkEl && boardLinkEl.href && boardLinkEl.href !== '#') {
        window.open(boardLinkEl.href, 'bodoge-board');
      }
    } catch (e) {
      toast('エラー: ' + e.message);
      resultEl.innerHTML = '❌ ' + escHtml(e.message);
      resultEl.className = 'generate-result visible';
      resultEl.style.color = 'var(--red)';
    } finally {
      btn.disabled = false;
      btn.textContent = '🚀 生成→再生';
      fetchStatus();
    }
  });

  // ディレイスライダー
  document.getElementById('delaySlider').addEventListener('input', function() {
    document.getElementById('delayValue').textContent = this.value + 'ms';
  });

  // ファイルアップロード
  document.getElementById('fileInput').addEventListener('change', async function() {
    const file = this.files[0];
    if (!file) return;
    await uploadFile(file);
  });

  const uploadArea = document.getElementById('uploadArea');
  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.style.borderColor = 'var(--accent)';
  });
  uploadArea.addEventListener('dragleave', () => {
    uploadArea.style.borderColor = '';
  });
  uploadArea.addEventListener('drop', async (e) => {
    e.preventDefault();
    uploadArea.style.borderColor = '';
    const file = e.dataTransfer.files[0];
    if (file) await uploadFile(file);
  });

  async function uploadFile(file) {
    uploadArea.innerHTML = '<div>⏳ 読み込み中...</div>';
    try {
      const text = await file.text();
      const r = await api('/api/replay/upload', JSON.parse(text));
      if (r.ok) {
        toast('リプレイ読み込み完了: ' + r.gameName + ' (' + r.rounds + 'ラウンド)');
        replayLoaded = true;
        lastLogCount = 0;
      } else {
        toast('読み込みエラー: ' + (r.error || '不明'));
        uploadArea.innerHTML = '<div>❌ 読み込み失敗</div>';
      }
    } catch (e) {
      toast('ファイルエラー: ' + e.message);
      uploadArea.innerHTML = '<div>❌ JSONパースエラー</div>';
    }
    fetchStatus();
  }

  // ── 対戦モード ──────────────────────────────────────────────────────────────

  function buildPlayStrategySelects(count) {
    const container = document.getElementById('playStrategySelects');
    container.innerHTML = '';
    for (let i = 0; i < count - 1; i++) {
      const sel = document.createElement('select');
      sel.id = 'playStratSel_' + i;
      sel.style.fontSize = '12px';
      const randomOpt = document.createElement('option');
      randomOpt.value = '';
      randomOpt.textContent = 'ランダム';
      sel.appendChild(randomOpt);
      for (const sid of STRATEGIES) {
        const opt = document.createElement('option');
        opt.value = sid;
        opt.textContent = STRATEGY_LABELS[sid] || sid;
        sel.appendChild(opt);
      }
      container.appendChild(sel);
    }
  }

  buildPlayStrategySelects(3);

  document.getElementById('playPlayerCount').addEventListener('change', function() {
    buildPlayStrategySelects(parseInt(this.value));
  });

  document.getElementById('btnPlayStart').addEventListener('click', async () => {
    const btn = document.getElementById('btnPlayStart');
    btn.disabled = true;
    btn.textContent = '⏳ 開始中...';

    try {
      const sheetUrl = document.getElementById('sheetUrl').value.trim();
      const setupPlayerCount = parseInt(document.getElementById('setupPlayerCount').value);
      const playerCount = parseInt(document.getElementById('playPlayerCount').value);
      const strats = [];
      for (let i = 0; i < playerCount - 1; i++) {
        const sel = document.getElementById('playStratSel_' + i);
        if (sel && sel.value) strats.push(sel.value);
      }

      // Step 1: 未接続なら接続
      if (!isConnected) {
        btn.textContent = '⏳ 接続中...';
        const boardUrl = document.getElementById('boardUrl').value.trim();
        const roomId = document.getElementById('roomId').value.trim();
        const connR = await api('/api/connect', { boardUrl, roomId: roomId || undefined });
        if (!connR.ok) throw new Error('接続失敗: ' + (connR.error || ''));
        localStorage.setItem('bridgeRoomId', connR.roomId);
        await fetchStatus();
      }

      // Step 2: スプシURLがあればセットアップ
      if (sheetUrl) {
        btn.textContent = '⏳ ゲーム設定中...';
        const setupR = await api('/api/setup-board', { sheetUrl, playerCount: setupPlayerCount });
        if (!setupR.ok) throw new Error('セットアップ失敗: ' + (setupR.error || ''));
      }

      // Step 3: 対戦開始
      btn.textContent = '⏳ 対戦開始...';
      const r = await api('/api/play/start', {
        playerCount,
        strategies: strats.length > 0 ? strats : undefined,
      });
      if (!r.ok) throw new Error(r.error || '開始に失敗しました');

      toast('対戦開始！ブラウザからカードを選択してください');
      lastLogCount = 0;

      // ボードを自動で開く
      await fetchStatus();
      const boardLinkEl = document.getElementById('boardLink');
      if (boardLinkEl && boardLinkEl.href && boardLinkEl.href !== '#') {
        window.open(boardLinkEl.href, 'bodoge-board');
      }
    } catch (e) {
      toast('エラー: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '🎮 対戦開始';
      fetchStatus();
    }
  });

  document.getElementById('btnPlayStop').addEventListener('click', async () => {
    await api('/api/play/stop', {});
    toast('対戦を中断しました');
    fetchStatus();
  });

  async function selectCard(card) {
    const r = await api('/api/play/select', { card });
    if (!r.ok) toast('選択エラー: ' + (r.error || ''));
    fetchStatus();
  }

  function updatePlayUI(s) {
    const isPlay = s.mode === 'play';
    document.getElementById('btnPlayStart').disabled = isPlay || s.mode === 'replay';
    document.getElementById('btnPlayStop').disabled = !isPlay;

    if (!isPlay && !(s.playInfo && s.playInfo.finished)) {
      document.getElementById('playStatusBox').textContent = '待機中';
      document.getElementById('playStatusBox').className = 'play-status-box play-status-idle';
      document.getElementById('playPointArea').style.display = 'none';
      document.getElementById('playHandArea').style.display = 'none';
      document.getElementById('playRoundResult').style.display = 'none';
      return;
    }

    const info = s.playInfo;
    if (!info || !info.active) return;

    // ラウンド情報
    if (info.round > 0) {
      document.getElementById('playPointArea').style.display = 'block';
      const pc = info.pointCard;
      const pcEl = document.getElementById('playPointCard');
      if (pc !== null) {
        pcEl.textContent = (pc > 0 ? '+' : '') + pc;
        pcEl.className = 'point-card-display ' + (pc > 0 ? 'point-positive' : 'point-negative');
      } else {
        pcEl.textContent = '—';
        pcEl.className = 'point-card-display';
      }
      const coEl = document.getElementById('playCarryOver');
      if (info.carryOver && info.carryOver.length > 0) {
        const total = info.carryOver.reduce((s, c) => s + c, 0);
        coEl.textContent = 'キャリーオーバー: ' + info.carryOver.join(', ') + ' (合計' + (total > 0 ? '+' : '') + total + ')';
      } else {
        coEl.textContent = '';
      }
    }

    // ラウンド結果
    if (info.lastRoundResult) {
      document.getElementById('playRoundResult').textContent = info.lastRoundResult;
      document.getElementById('playRoundResult').style.display = 'block';
    } else {
      document.getElementById('playRoundResult').style.display = 'none';
    }

    // ステータス & 手札
    if (info.finished) {
      document.getElementById('playStatusBox').textContent = 'ゲーム終了！';
      document.getElementById('playStatusBox').className = 'play-status-box play-status-finished';
      document.getElementById('playHandArea').style.display = 'none';
    } else if (info.waitingForHuman) {
      document.getElementById('playStatusBox').textContent = 'あなたの番です — カードを選んでください';
      document.getElementById('playStatusBox').className = 'play-status-box play-status-waiting';

      // 手札ボタン描画
      document.getElementById('playHandArea').style.display = 'block';
      const handEl = document.getElementById('playHand');
      handEl.innerHTML = '';
      for (const card of (info.humanHand || [])) {
        const btn = document.createElement('button');
        btn.className = 'card-btn ' + (card > 0 ? 'positive' : card < 0 ? 'negative' : '');
        btn.textContent = card;
        btn.title = 'カード ' + card + ' を出す';
        btn.onclick = () => selectCard(card);
        handEl.appendChild(btn);
      }
    } else {
      document.getElementById('playStatusBox').textContent = 'AI思考中...';
      document.getElementById('playStatusBox').className = 'play-status-box play-status-thinking';
      document.getElementById('playHandArea').style.display = 'none';
    }
  }


  // ── 魔女ゲー ──────────────────────────────────────────────────────────────

  const MAJO_STRATEGIES = ['majo_balanced', 'majo_aggressive', 'majo_economist'];
  const MAJO_STRATEGY_LABELS = {
    majo_balanced: 'バランス型',
    majo_aggressive: '攻撃型',
    majo_economist: '経済型',
  };

  // 魔女ゲー戦略セレクト初期化
  (function buildMajoStrategySelects() {
    const container = document.getElementById('majoStrategySelects');
    if (!container) return;
    container.innerHTML = '';
    for (let i = 0; i < 3; i++) {
      const sel = document.createElement('select');
      sel.id = 'majoStrat_' + i;
      sel.style.fontSize = '12px';
      const randomOpt = document.createElement('option');
      randomOpt.value = '';
      randomOpt.textContent = 'ランダム';
      sel.appendChild(randomOpt);
      for (const sid of MAJO_STRATEGIES) {
        const opt = document.createElement('option');
        opt.value = sid;
        opt.textContent = MAJO_STRATEGY_LABELS[sid] || sid;
        sel.appendChild(opt);
      }
      container.appendChild(sel);
    }
  })();

  document.getElementById('btnMajoStart').addEventListener('click', async () => {
    const strategies = [];
    for (let i = 0; i < 3; i++) {
      const sel = document.getElementById('majoStrat_' + i);
      if (sel && sel.value) strategies.push(sel.value);
    }
    const r = await api('/api/majo/start', { strategies });
    if (!r.ok) toast('エラー: ' + r.error);
    lastLogCount = 0;
    fetchStatus();
  });

  document.getElementById('btnMajoStop').addEventListener('click', async () => {
    await api('/api/majo/stop', {});
    fetchStatus();
  });

  let majoPolling = null;
  let lastMajoActionsHtml = '';

  function updateMajoUI(s) {
    const isMajo = s.mode === 'majo';
    document.getElementById('btnMajoStart').disabled = isMajo || s.mode !== 'idle';
    document.getElementById('btnMajoStop').disabled = !isMajo;

    if (!isMajo && !s.majoActive) {
      document.getElementById('majoStatusBox').textContent = '待機中';
      document.getElementById('majoStatusBox').className = 'play-status-box play-status-idle';
      document.getElementById('majoBoardArea').style.display = 'none';
      if (majoPolling) { clearInterval(majoPolling); majoPolling = null; }
      return;
    }

    // 魔女ゲー状態のポーリング開始
    if (!majoPolling && isMajo) {
      majoPolling = setInterval(fetchMajoState, 600);
      fetchMajoState();
    }
  }

  async function fetchMajoState() {
    try {
      const r = await api('/api/majo/state');
      if (!r.ok || !r.active) return;
      renderMajoBoard(r);
    } catch(e) {}
  }

  const MAJO_PLAYER_ICONS = { p0: '🔵', p1: '🟣', p2: '🟢', p3: '🟡' };

  function renderMajoBoard(info) {
    document.getElementById('majoBoardArea').style.display = 'block';

    // ラウンド表示
    document.getElementById('majoRoundInfo').textContent =
      'ラウンド ' + info.round + ' — ' +
      (info.isHumanTurn ? '🎮 あなたのターン' : info.currentPlayerName + 'のターン');

    // ステータスボックス
    const statusBox = document.getElementById('majoStatusBox');
    if (info.gameOver) {
      statusBox.textContent = 'ゲーム終了！';
      statusBox.className = 'play-status-box play-status-finished';
    } else if (info.isHumanTurn) {
      statusBox.textContent = '🎮 あなたのターン — アクションを選んでください';
      statusBox.className = 'play-status-box play-status-waiting';
    } else {
      statusBox.textContent = info.currentPlayerName + ' 思考中...';
      statusBox.className = 'play-status-box play-status-thinking';
    }

    // 魔導具展示
    const toolSupply = document.getElementById('majoToolSupply');
    toolSupply.innerHTML = info.toolSupply.map(t =>
      '<div class="majo-card">' +
      '<div class="majo-card-name">' + escHtml(t.name) + ' (コスト' + t.cost + '/魔力' + t.magicPower + ')</div>' +
      '<div class="majo-card-detail">' + escHtml(t.effect) + '</div></div>'
    ).join('');

    // 聖者展示
    const saintSupply = document.getElementById('majoSaintSupply');
    saintSupply.innerHTML = info.saintSupply.map(s =>
      '<div class="majo-card">' +
      '<div class="majo-card-name">' + escHtml(s.name) + ' (HP' + s.hp + '/★' + s.vp + ')</div>' +
      '<div class="majo-card-detail">撃破報酬: マナ+' + s.manaReward + ' 聖遺物+' + s.relicDraw + '</div></div>'
    ).join('');

    // デッキカウント
    document.getElementById('majoRelicDeckCount').textContent = info.relicDeckCount;
    document.getElementById('majoToolDeckCount').textContent = info.toolDeckCount;
    document.getElementById('majoSaintDeckCount').textContent = info.saintDeckCount;

    // フィールド
    const fieldEl = document.getElementById('majoFieldActions');
    fieldEl.innerHTML = info.fieldActions.map(f => {
      const slotsText = f.maxSlots === -1 ? '∞' : f.usedSlots + '/' + f.maxSlots;
      const full = f.maxSlots !== -1 && f.usedSlots >= f.maxSlots;
      return '<div class="majo-field-slot' + (full ? ' full' : '') + '">' + escHtml(f.name) + ' [' + slotsText + ']</div>';
    }).join('');

    // プレイヤー情報
    const playersEl = document.getElementById('majoPlayers');
    playersEl.innerHTML = info.players.map(p => {
      const icon = MAJO_PLAYER_ICONS[p.id] || '⚪';
      const isCurrent = p.id === info.currentPlayerId;
      const cls = 'majo-player' + (p.isHuman ? ' is-human' : '') + (isCurrent ? ' is-current' : '');
      const tools = p.tools.length > 0
        ? p.tools.map(t => t.name + '(' + t.magicPower + ')' + (t.tapped ? '(T)' : '')).join(', ')
        : 'なし';
      const saints = p.saints.length > 0
        ? p.saints.map(s => s.name + '(★' + s.vp + ')').join(', ')
        : 'なし';
      const relics = p.relics.length > 0
        ? p.relics.map(r => r.id).join(', ')
        : 'なし';
      return '<div class="' + cls + '">' +
        '<div class="majo-player-header"><span>' + icon + ' ' + escHtml(p.name) +
        (p.isHuman ? ' (あなた)' : '') + '</span>' +
        '<span>★' + p.vp + 'VP | マナ ' + p.mana + (p.tappedMana > 0 ? '(タップ' + p.tappedMana + ')' : '') + '</span></div>' +
        '<div class="majo-player-stats">魔導具: ' + tools + '</div>' +
        '<div class="majo-player-stats">聖者: ' + saints + '</div>' +
        '<div class="majo-player-stats">聖遺物: ' + relics + '</div>' +
        '<div class="majo-player-stats">' +
        (p.witchUsed ? '魔女:済' : '魔女:未') + ' / ' +
        (p.familiarUsed ? '使い魔:済' : '使い魔:未') +
        '</div></div>';
    }).join('');

    // アクション選択
    const actionArea = document.getElementById('majoActionArea');
    const actionsEl = document.getElementById('majoActions');
    if (info.isHumanTurn && info.availableActions.length > 0) {
      actionArea.style.display = 'block';
      const newHtml = info.availableActions.map(a =>
        '<button class="majo-action-btn cat-' + a.category + '" data-idx="' + a.index + '">' +
        escHtml(a.description) + '</button>'
      ).join('');
      // 変更があった時のみ再描画（ちらつき防止）
      if (newHtml !== lastMajoActionsHtml) {
        actionsEl.innerHTML = newHtml;
        lastMajoActionsHtml = newHtml;
        // イベントリスナー
        actionsEl.querySelectorAll('.majo-action-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const idx = parseInt(btn.getAttribute('data-idx'));
            selectMajoAction(idx);
          });
        });
      }
    } else {
      actionArea.style.display = 'none';
      lastMajoActionsHtml = '';
    }

    // イベントログ
    const eventLog = document.getElementById('majoEventLog');
    if (info.lastEvents && info.lastEvents.length > 0) {
      eventLog.innerHTML = info.lastEvents.map(e => '<div>📦 ' + escHtml(e) + '</div>').join('');
    } else {
      eventLog.innerHTML = '';
    }

    // ゲーム終了時の最終結果
    if (info.gameOver && info.finalScores) {
      const resultHtml = info.finalScores.map(s => {
        const medal = s.rank === 1 ? '👑' : s.rank === 2 ? '🥈' : s.rank === 3 ? '🥉' : '';
        const isHuman = s.playerId === info.humanPlayerId ? ' ← あなた' : '';
        return '<div>' + medal + ' ' + s.rank + '位 ' + escHtml(s.name) + ': ★' + s.victoryPoints + 'VP' + isHuman + '</div>';
      }).join('');
      document.getElementById('majoEventLog').innerHTML =
        '<div style="margin-top:8px;font-weight:700">━━━ 最終結果 ━━━</div>' + resultHtml;
    }
  }

  async function selectMajoAction(index) {
    const r = await api('/api/majo/action', { index });
    if (!r.ok) toast('エラー: ' + r.error);
    fetchMajoState();
  }

  // ── ページロード時の自動再接続 ─────────────────────────────────────────────
  async function autoReconnect() {
    const s = await api('/api/status');
    if (s.connected) return; // 既に接続中なら何もしない
    const savedRoomId = localStorage.getItem('bridgeRoomId');
    if (!savedRoomId) return;
    const boardUrl = document.getElementById('boardUrl').value.trim();
    try {
      const r = await api('/api/connect', { boardUrl, roomId: savedRoomId });
      if (r.ok) {
        toast('前回のルーム(' + r.roomId + ')に再接続しました');
      } else {
        localStorage.removeItem('bridgeRoomId');
      }
    } catch { /* ignore */ }
    fetchStatus();
  }

  // ── ポーリング開始 ─────────────────────────────────────────────────────────
  autoReconnect();
  pollInterval = setInterval(fetchStatus, 800);
</script>
</body>
</html>`;
}
// ── HTTPサーバー ──────────────────────────────────────────────────────────────
export function startControlServer(port = 3216) {
    const server = createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }
        const url = req.url || '/';
        try {
            // HTML コントロールパネル
            if (url === '/' && req.method === 'GET') {
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                res.writeHead(200);
                res.end(getHtml());
                return;
            }
            // 観戦リダイレクト: 常に正しいルームIDへ転送
            if (url === '/spectate' && req.method === 'GET') {
                if (currentRoomId) {
                    res.writeHead(302, { Location: `http://localhost:3210/?spectate=${currentRoomId}` });
                    res.end();
                }
                else {
                    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                    res.writeHead(404);
                    res.end('ルームがありません。ゲームを開始してください。');
                }
                return;
            }
            // JSON API
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            if (url === '/api/status' && req.method === 'GET') {
                res.writeHead(200);
                res.end(JSON.stringify(handleStatus()));
                return;
            }
            if (url === '/api/strategies' && req.method === 'GET') {
                res.writeHead(200);
                res.end(JSON.stringify({ strategies: strategyIds.map((sid) => ({ id: sid, name: strategies[sid].name, description: strategies[sid].description })) }));
                return;
            }
            if (req.method === 'POST') {
                const body = await readBody(req);
                if (url === '/api/connect') {
                    const result = await handleConnect(body);
                    res.writeHead(200);
                    res.end(JSON.stringify(result));
                    return;
                }
                if (url === '/api/disconnect') {
                    const result = await handleDisconnect();
                    res.writeHead(200);
                    res.end(JSON.stringify(result));
                    return;
                }
                if (url === '/api/setup-board') {
                    const result = await handleSetupBoard(body);
                    res.writeHead(200);
                    res.end(JSON.stringify(result));
                    return;
                }
                if (url === '/api/replay/upload') {
                    const result = await handleReplayUpload(body);
                    res.writeHead(200);
                    res.end(JSON.stringify(result));
                    return;
                }
                if (url === '/api/replay/generate') {
                    const result = await handleReplayGenerate(body);
                    res.writeHead(200);
                    res.end(JSON.stringify(result));
                    return;
                }
                if (url === '/api/replay/start') {
                    const result = await handleReplayStart(body);
                    res.writeHead(200);
                    res.end(JSON.stringify(result));
                    return;
                }
                if (url === '/api/replay/pause') {
                    const result = await handleReplayPause();
                    res.writeHead(200);
                    res.end(JSON.stringify(result));
                    return;
                }
                if (url === '/api/replay/resume') {
                    const result = await handleReplayResume();
                    res.writeHead(200);
                    res.end(JSON.stringify(result));
                    return;
                }
                if (url === '/api/replay/step') {
                    const result = await handleReplayStep();
                    res.writeHead(200);
                    res.end(JSON.stringify(result));
                    return;
                }
                if (url === '/api/replay/stop') {
                    const result = await handleReplayStop();
                    res.writeHead(200);
                    res.end(JSON.stringify(result));
                    return;
                }
                if (url === '/api/replay/back') {
                    const result = await handleReplayBack();
                    res.writeHead(200);
                    res.end(JSON.stringify(result));
                    return;
                }
                if (url === '/api/play/start') {
                    const result = await handlePlayStart(body);
                    res.writeHead(200);
                    res.end(JSON.stringify(result));
                    return;
                }
                if (url === '/api/play/select') {
                    const result = await handlePlaySelect(body);
                    res.writeHead(200);
                    res.end(JSON.stringify(result));
                    return;
                }
                if (url === '/api/play/stop') {
                    const result = await handlePlayStop();
                    res.writeHead(200);
                    res.end(JSON.stringify(result));
                    return;
                }
                // 魔女ゲー API
                if (url === '/api/majo/start') {
                    const result = await handleMajoStart(body);
                    res.writeHead(200);
                    res.end(JSON.stringify(result));
                    return;
                }
                if (url === '/api/majo/action') {
                    const result = await handleMajoAction(body);
                    res.writeHead(200);
                    res.end(JSON.stringify(result));
                    return;
                }
                if (url === '/api/majo/stop') {
                    const result = await handleMajoStop();
                    res.writeHead(200);
                    res.end(JSON.stringify(result));
                    return;
                }
            }
            if (url === '/api/play/state' && req.method === 'GET') {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.writeHead(200);
                res.end(JSON.stringify(handlePlayState()));
                return;
            }
            if (url === '/api/majo/state' && req.method === 'GET') {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.writeHead(200);
                res.end(JSON.stringify(handleMajoState()));
                return;
            }
            if (url === '/api/resync' && req.method === 'GET') {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                if (bridgeClient && bridgeClient.isConnected()) {
                    bridgeClient.sendState();
                    res.writeHead(200);
                    res.end(JSON.stringify({ ok: true }));
                }
                else {
                    res.writeHead(200);
                    res.end(JSON.stringify({ ok: false, error: 'ボード未接続' }));
                }
                return;
            }
            if (url === '/api/majo/strategies' && req.method === 'GET') {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.writeHead(200);
                res.end(JSON.stringify({
                    strategies: majoStrategyIds.map((sid) => {
                        const s = getMajoStrategy(sid);
                        return { id: sid, name: s.name, description: s.description };
                    }),
                }));
                return;
            }
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Not Found' }));
        }
        catch (err) {
            console.error('[control-server] Error:', err);
            if (!res.headersSent) {
                res.writeHead(500);
                res.end(JSON.stringify({ error: err.message }));
            }
        }
    });
    server.listen(port, () => {
        console.log(`\n[control-server] ===================================`);
        console.log(`[control-server] コントロールパネル: http://localhost:${port}/`);
        console.log(`[control-server] ===================================\n`);
    });
    server.on('error', (err) => {
        console.error(`[control-server] サーバーエラー:`, err);
    });
}
