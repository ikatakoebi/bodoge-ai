// Modern Art ゲームデータ：Google Sheetsから読み込み
// シート構成（魔女ゲーと統一）: cards, areas, counters, templates, setup

import type { ModernArtCard, ArtistName, AuctionType } from './modern-art-types.js';

const VALID_ARTISTS: Set<string> = new Set(['Lite Metal', 'Yoko', 'Christin P', 'Karl Gitter', 'Krypto']);
const VALID_AUCTION_TYPES: Set<string> = new Set(['open', 'once_around', 'sealed', 'fixed_price', 'double']);

// ── 型定義 ──

export interface ModernArtConfig {
  initialMoney: number;
  roundCount: number;
  roundEndCardCount: number;
  playerMin: number;
  playerMax: number;
}

export interface ModernArtDeal {
  [playerCount: number]: number[];
}

export interface ModernArtValues {
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

  // gviz URL（シート名指定、魔女ゲーと同じ方式）
  const [cardsCsv, setupCsv] = await Promise.all([
    fetchSheetByName(spreadsheetId, 'cards'),
    fetchSheetByName(spreadsheetId, 'setup'),
  ]);

  const cards = parseCardsCsv(cardsCsv);
  const { config, deal, values } = parseSetupCsv(setupCsv);

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

// ── フェッチ（gviz URL、シート名指定） ──

async function fetchSheetByName(sheetId: string, sheetName: string): Promise<string> {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}&headers=1`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'BodogeAI/1.0' },
    redirect: 'follow',
  });
  const text = await res.text();
  if (!res.ok || text.trimStart().startsWith('<!')) {
    throw new Error(`シート "${sheetName}" 取得失敗: ${res.status}`);
  }
  return text;
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

// ── setupシート（config/deal/values統合） ──

function parseSetupCsv(csv: string): { config: ModernArtConfig; deal: ModernArtDeal; values: ModernArtValues } {
  const lines = csv.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.trim());

  const configMap = new Map<string, string>();
  const deal: ModernArtDeal = {};
  let artistValuesStr = '30,20,10';

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    const action = fields[0]?.trim();
    const key = fields[1]?.trim();
    const value = fields[2]?.trim();

    if (action === 'config' && key) {
      if (key === 'artistValues') {
        artistValuesStr = value;
      } else {
        configMap.set(key, value);
      }
    } else if (action === 'engine_deal' && key) {
      const playerCount = parseInt(key, 10);
      if (!isNaN(playerCount) && value) {
        deal[playerCount] = value.split(',').map(v => parseInt(v.trim(), 10));
      }
    }
  }

  const config: ModernArtConfig = {
    initialMoney: parseInt(configMap.get('initialMoney') || '100', 10),
    roundCount: parseInt(configMap.get('roundCount') || '4', 10),
    roundEndCardCount: parseInt(configMap.get('roundEndCardCount') || '5', 10),
    playerMin: parseInt(configMap.get('playerMin') || '3', 10),
    playerMax: parseInt(configMap.get('playerMax') || '5', 10),
  };

  const rankValues = artistValuesStr.split(',').map(v => parseInt(v.trim(), 10));
  const values: ModernArtValues = { rankValues };

  return { config, deal, values };
}
