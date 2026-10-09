import { AppSave, Settings } from '../types/game';

const KEY = 'pro_football_3d_save_v3';

export const DEFAULT_SETTINGS: Settings = {
  difficulty: 'NORMAL',
  halfLengthSec: 60,
  quality: 'HIGH',
  cameraZoom: 1.2,
  sfx: true,
  crowd: true,
  autoSwitch: true,
  passMode: 'ASSISTED',
  strictness: 'STANDARD',
  stadium: 'ARENA',
};

export const EMPTY_SAVE: AppSave = {
  version: 3,
  settings: DEFAULT_SETTINGS,
  seasons: {},
  worldCup: null,
  history: [],
  career: { played: 0, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, trophies: [] },
};

export function loadSave(): AppSave {
  if (typeof window === 'undefined') return EMPTY_SAVE;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return EMPTY_SAVE;
    const parsed = JSON.parse(raw) as Partial<AppSave>;
    return {
      version: 3,
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
      seasons: parsed.seasons || {},
      worldCup: parsed.worldCup || null,
      history: Array.isArray(parsed.history) ? parsed.history.slice(0, 40) : [],
      career: { ...EMPTY_SAVE.career, ...(parsed.career || {}) },
    };
  } catch {
    return EMPTY_SAVE;
  }
}

/** Returns true only when the data was genuinely written to storage. */
export function persist(save: AppSave): boolean {
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(save));
    return true;
  } catch {
    return false;
  }
}

export function clearSave(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}
