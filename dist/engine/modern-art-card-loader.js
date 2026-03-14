// Modern Art ゲームデータ：Google Sheetsから読み込み
// シート構成: cards, config, deal, values
const VALID_ARTISTS = new Set(['Lite Metal', 'Yoko', 'Christin P', 'Karl Gitter', 'Krypto']);
const VALID_AUCTION_TYPES = new Set(['open', 'once_around', 'sealed', 'fixed_price', 'double']);
// シートgid（API作成時に決まった値）
const SHEET_GIDS = {
    cards: 610505371,
    config: 1889636086,
    deal: 1011904364,
    values: 417227694,
};
// ── キャッシュ ──
let cachedData = null;
let spreadsheetId = null;
/** スプレッドシートIDを設定 */
export function setModernArtSheetId(sheetId) {
    spreadsheetId = sheetId;
    cachedData = null;
}
/** 全ゲームデータを読み込む */
export async function loadModernArtGameData() {
    if (cachedData)
        return cachedData;
    if (!spreadsheetId)
        throw new Error('Modern ArtのスプレッドシートIDが設定されていません。setModernArtSheetId()を呼んでください');
    const baseUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv`;
    const [cardsCsv, configCsv, dealCsv, valuesCsv] = await Promise.all([
        fetchSheet(baseUrl, SHEET_GIDS.cards),
        fetchSheet(baseUrl, SHEET_GIDS.config),
        fetchSheet(baseUrl, SHEET_GIDS.deal),
        fetchSheet(baseUrl, SHEET_GIDS.values),
    ]);
    const cards = parseCardsCsv(cardsCsv);
    const config = parseConfigCsv(configCsv);
    const deal = parseDealCsv(dealCsv);
    const values = parseValuesCsv(valuesCsv);
    cachedData = { cards, config, deal, values };
    console.log(`[modern-art] ${cards.length}枚カード, 初期資金${config.initialMoney}, ${config.roundCount}ラウンド`);
    return cachedData;
}
/** カードデータのみ読み込む（後方互換） */
export async function loadModernArtCards() {
    const data = await loadModernArtGameData();
    return data.cards;
}
/** キャッシュクリア */
export function clearModernArtCardCache() {
    cachedData = null;
}
// ── フェッチ ──
async function fetchSheet(baseUrl, gid) {
    const url = `${baseUrl}&gid=${gid}`;
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok)
        throw new Error(`シート取得失敗 (gid=${gid}): ${res.status}`);
    return res.text();
}
// ── CSVパース共通 ──
function parseCsvLine(line) {
    const fields = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"') {
                if (i + 1 < line.length && line[i + 1] === '"') {
                    current += '"';
                    i++;
                }
                else {
                    inQuotes = false;
                }
            }
            else {
                current += ch;
            }
        }
        else {
            if (ch === '"') {
                inQuotes = true;
            }
            else if (ch === ',') {
                fields.push(current);
                current = '';
            }
            else {
                current += ch;
            }
        }
    }
    fields.push(current);
    return fields;
}
function parseCsvLines(csv) {
    return csv.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.trim()).map(parseCsvLine);
}
// ── cardsシート ──
function parseCardsCsv(csv) {
    const lines = csv.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.trim());
    if (lines.length < 2)
        throw new Error('cardsシートが空');
    const headers = parseCsvLine(lines[0]);
    const col = (name) => headers.indexOf(name);
    const idCol = col('id');
    const artistCol = col('artist');
    const auctionCol = col('auctionType');
    if (idCol < 0 || artistCol < 0 || auctionCol < 0) {
        throw new Error(`cards列不足。必要: id, artist, auctionType。実際: ${headers.join(', ')}`);
    }
    const cards = [];
    for (let i = 1; i < lines.length; i++) {
        const fields = parseCsvLine(lines[i]);
        const id = fields[idCol]?.trim();
        if (!id || id.startsWith('#'))
            continue;
        const artist = fields[artistCol]?.trim();
        const auctionType = fields[auctionCol]?.trim();
        if (!VALID_ARTISTS.has(artist)) {
            console.warn(`[modern-art] 不明な画家 "${artist}" (行${i + 1}) — スキップ`);
            continue;
        }
        if (!VALID_AUCTION_TYPES.has(auctionType)) {
            console.warn(`[modern-art] 不明なオークション種別 "${auctionType}" (行${i + 1}) — スキップ`);
            continue;
        }
        cards.push({
            id,
            artist: artist,
            auctionType: auctionType,
        });
    }
    if (cards.length === 0)
        throw new Error('有効なカードが0枚');
    return cards;
}
// ── configシート ──
function parseConfigCsv(csv) {
    const rows = parseCsvLines(csv);
    const map = new Map();
    // ヘッダー行(key,value)の後にデータ
    for (let i = 1; i < rows.length; i++) {
        const key = rows[i][0]?.trim();
        const val = rows[i][1]?.trim();
        if (key)
            map.set(key, val);
    }
    return {
        initialMoney: parseInt(map.get('initialMoney') || '100', 10),
        roundCount: parseInt(map.get('roundCount') || '4', 10),
        roundEndCardCount: parseInt(map.get('roundEndCardCount') || '5', 10),
        playerMin: parseInt(map.get('playerMin') || '3', 10),
        playerMax: parseInt(map.get('playerMax') || '5', 10),
    };
}
// ── dealシート ──
function parseDealCsv(csv) {
    const rows = parseCsvLines(csv);
    // ヘッダー: players, round1, round2, round3, round4
    const deal = {};
    for (let i = 1; i < rows.length; i++) {
        const playerCount = parseInt(rows[i][0]?.trim(), 10);
        if (isNaN(playerCount))
            continue;
        const rounds = [];
        for (let j = 1; j < rows[i].length; j++) {
            const v = parseInt(rows[i][j]?.trim(), 10);
            if (!isNaN(v))
                rounds.push(v);
        }
        deal[playerCount] = rounds;
    }
    return deal;
}
// ── valuesシート ──
function parseValuesCsv(csv) {
    const rows = parseCsvLines(csv);
    // ヘッダー: rank, value
    const rankValues = [];
    for (let i = 1; i < rows.length; i++) {
        const val = parseInt(rows[i][1]?.trim(), 10);
        if (!isNaN(val))
            rankValues.push(val);
    }
    if (rankValues.length === 0)
        throw new Error('valuesシートが空');
    return { rankValues };
}
