export type PartCount = 2 | 3 | 4;
export type HarmonyMode = 'major' | 'minor';
export const HARMONY_STYLES = {
  'modern-pop': { label: 'Modern Pop', description: 'Warm thirds, sixths, and an airy ninth.' },
  'neo-soul': { label: 'Neo-Soul / R&B', description: 'Thirds, sevenths, and ninths with more tension.' },
  hymn: { label: 'Traditional / Hymn', description: 'Classic fifth, third, and octave layers.' },
} as const;
export type HarmonyStyle = keyof typeof HARMONY_STYLES;
export type Voice = 'tenor' | 'alto' | 'bass';
export const VOICE_RANGES = {
  bass: { label: 'Bass', low: 40, high: 64 },
  baritone: { label: 'Baritone', low: 43, high: 67 },
  tenor: { label: 'Tenor', low: 48, high: 72 },
  alto: { label: 'Alto', low: 53, high: 77 },
  mezzo: { label: 'Mezzo-soprano', low: 57, high: 81 },
  soprano: { label: 'Soprano', low: 60, high: 84 },
} as const;
export type VoiceRange = keyof typeof VOICE_RANGES;
export type RangeSelection = VoiceRange | 'auto';
export interface PitchAnalysis {
  detectedRange: VoiceRange | null;
  lowMidi?: number;
  highMidi?: number;
  medianMidi?: number;
  lowNote?: string;
  highNote?: string;
  voicedFrames: number;
  sampledFrames: number;
  confidence: 'limited' | 'good' | 'unavailable';
}

export interface AudioTrack {
  name: string;
  label: string;
  url: string;
  downloadUrl: string;
  semitones: number;
  lowNote?: string;
  highNote?: string;
  outsideRange?: boolean;
  sourceTrackName?: string;
}

export interface HarmonyJob {
  id: string;
  status: 'processing' | 'complete' | 'failed';
  stage: string;
  progress: number;
  parts: PartCount;
  mode: HarmonyMode;
  style: HarmonyStyle;
  rangeSelection: RangeSelection;
  targetRange?: VoiceRange;
  analysis?: PitchAnalysis;
  sourceName: string;
  createdAt: string;
  expiresAt: string | null;
  saved?: boolean;
  duration?: number;
  original?: AudioTrack;
  tracks: AudioTrack[];
  takes?: AudioTrack[];
  error?: string;
}

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_DURATION_SECONDS = 600;
export interface AccountUser { id: string; email: string; }
