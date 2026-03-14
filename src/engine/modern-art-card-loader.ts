// Modern Art ゲームデータ：Google Sheetsから読み込み
// シート構成: cards, config, deal, values

import type { ModernArtCard, ArtistName, AuctionType } from './modern-art-types.js';

const VALID_ARTISTS: Set<string> = new Set(['Lite Metal', 'Yoko', 'Christin P', 'Karl Gitter', 'Krypto']);
const VALID_AUCTION_TYPES: Set<string> = new Set(['open', 'once_around', 'sealed', 'fixed_price', 'double']);

// シートgid（API作成時に決まった値）
const SHEET_GIDS = {
  cards: 610505371,
  config: 1889636086,
  deal: 1011904364,
  values: 417227694,
};

// ── 型定義 ──

export interface ModernArtConfig {
  initialMoney: number;
  roundCount: number;
  roundEndCardCount: number;
  playerMin: number;
  playerMax: number;
}

export interface ModernArtDeal {
  // playerCount -> [round1枚数, round2枚数, ...]
  [playerCount: number]: number[];
}

export interface ModernArtValues {
  // rank(1,2,3) -> value(30,20,10)
  rankValues: number[];
}

export interface ModernArtGameData {
  cards: ModernArtCard[];
  config: ModernArtConfig;
  deal: ModernArtDeal;
  values: ModernArtValues;
}

// ── キャッシュ ──

let cachedData: ModernArtGameData | null = null;
let spreadsheetId: string | null = null;

/** スプレッドシートIDを設定 */
export function setModernArtSheetId(sheetId: string): void {
  spreadsheetId = sheetId;
  cachedData = null;
}

/** 全ゲームデータを読み込む */
export async function loadModernArtGameData(): Promise<ModernArtGameData> {
  if (cachedData) return cachedData;
  if (!spreadsheetId) throw new Error('Modern ArtのスプレッドシートIDが設定されていません。setModernArtSheetId()を呼んでください');

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
export async function loadModernArtCards(): Promise<ModernArtCard[]> {
  const data = await loadModernArtGameData();
  return data.cards;
}

/** キャッシュクリア */
export function clearModernArtCardCache(): void {
  cachedData = null;
}

// ── フェッチ ──

async function fetchSheet(baseUrl: string, gid: number): Promise<string> {
  const url = `${baseUrl}&gid=${gid}`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`シート取得失敗 (gid=${gid}): ${res.status}`);
  return res.text();
}

// ── CSVパース共通 ──

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

function parseCsvLines(csv: string): string[][] {
  return csv.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.trim()).map(parseCsvLine);
}

// ── cardsシート ──

function parseCardsCsv(csv: string): ModernArtCard[] {
  const lines = csv.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.trim());
  if (lines.length < 2) throw new Error('cardsシートが空');

  const headers = parseCsvLine(lines[0]);
  const col = (name: string) => headers.indexOf(name);

  const idCol = col('id');
  const artistCol = col('artist');
  const auctionCol = col('auctionType');

  if (idCol < 0 || artistCol < 0 || auctionCol < 0) {
    throw new Error(`cards列不足。必要: id, artist, auctionType。実際: ${headers.join(', ')}`);
  }

  const cards: ModernArtCard[] = [];

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    const id = fields[idCol]?.trim();
    if (!id || id.startsWith('#')) continue;

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
      artist: artist as ArtistName,
      auctionType: auctionType as AuctionType,
    });
  }

  if (cards.length === 0) throw new Error('有効なカードが0枚');
  return cards;
}

// ── configシート ──

function parseConfigCsv(csv: string): ModernArtConfig {
  const rows = parseCsvLines(csv);
  const map = new Map<string, string>();
  // ヘッダー行(key,value)の後にデータ
  for (let i = 1; i < rows.length; i++) {
    const key = rows[i][0]?.trim();
    const val = rows[i][1]?.trim();
    if (key) map.set(key, val);
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

function parseDealCsv(csv: string): ModernArtDeal {
  const rows = parseCsvLines(csv);
  // ヘッダー: players, round1, round2, round3, round4
  const deal: ModernArtDeal = {};

  for (let i = 1; i < rows.length; i++) {
    const playerCount = parseInt(rows[i][0]?.trim(), 10);
    if (isNaN(playerCount)) continue;
    const rounds: number[] = [];
    for (let j = 1; j < rows[i].length; j++) {
      const v = parseInt(rows[i][j]?.trim(), 10);
      if (!isNaN(v)) rounds.push(v);
    }
    deal[playerCount] = rounds;
  }

  return deal;
}

// ── valuesシート ──

function parseValuesCsv(csv: string): ModernArtValues {
  const rows = parseCsvLines(csv);
  // ヘッダー: rank, value
  const rankValues: number[] = [];

  for (let i = 1; i < rows.length; i++) {
    const val = parseInt(rows[i][1]?.trim(), 10);
    if (!isNaN(val)) rankValues.push(val);
  }

  if (rankValues.length === 0) throw new Error('valuesシートが空');
  return { rankValues };
}
