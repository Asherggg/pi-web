export const BACKGROUND_PREFERENCES_KEY = "pi-personalization-background";
export const SOUND_PRESET_KEY = "pi-sound-preset";
export const SOUND_VOLUME_KEY = "pi-sound-volume";
export const SOUND_CUSTOM_NAME_KEY = "pi-sound-custom-name";

export const BACKGROUND_ASSET_KEY = "background" as const;
export const COMPLETION_SOUND_ASSET_KEY = "completion-sound" as const;

export const MAX_BACKGROUND_FILE_BYTES = 20 * 1024 * 1024;
export const MIN_BACKGROUND_STRENGTH = 0.01;
export const MAX_BACKGROUND_STRENGTH = 0.8;
export const MAX_SOUND_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_CUSTOM_SOUND_SECONDS = 15;

export type BackgroundFit = "cover" | "contain";

export interface BackgroundPreferences {
  strength: number;
  fit: BackgroundFit;
  assetName: string | null;
}

export const DEFAULT_BACKGROUND_PREFERENCES: BackgroundPreferences = {
  strength: 0.55,
  fit: "cover",
  assetName: null,
};

export type BuiltInSoundPreset = "classic" | "soft" | "bright";
export type SoundPreset = BuiltInSoundPreset | "custom";

export const BUILT_IN_SOUND_PRESETS: readonly BuiltInSoundPreset[] = [
  "classic",
  "soft",
  "bright",
];

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function parseBackgroundPreferences(raw: string | null): BackgroundPreferences {
  if (!raw) return DEFAULT_BACKGROUND_PREFERENCES;

  try {
    const parsed = JSON.parse(raw) as Partial<BackgroundPreferences>;
    const strength = typeof parsed.strength === "number" && Number.isFinite(parsed.strength)
      ? clampNumber(parsed.strength, MIN_BACKGROUND_STRENGTH, MAX_BACKGROUND_STRENGTH)
      : DEFAULT_BACKGROUND_PREFERENCES.strength;
    const fit = parsed.fit === "contain" || parsed.fit === "cover"
      ? parsed.fit
      : DEFAULT_BACKGROUND_PREFERENCES.fit;
    const assetName = typeof parsed.assetName === "string" && parsed.assetName.trim()
      ? parsed.assetName
      : null;

    return { strength, fit, assetName };
  } catch {
    return DEFAULT_BACKGROUND_PREFERENCES;
  }
}

export function parseSoundPreset(raw: string | null): SoundPreset {
  return raw === "soft" || raw === "bright" || raw === "custom" ? raw : "classic";
}

export function parseSoundVolume(raw: string | null): number {
  if (raw === null) return 1;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? clampNumber(parsed, 0, 1) : 1;
}

export function getBackgroundSurfaceAlphas(strength: number): {
  surface: number;
  panel: number;
} {
  const normalized = clampNumber(strength, MIN_BACKGROUND_STRENGTH, MAX_BACKGROUND_STRENGTH);
  const legacyFloor = 0.2;
  const legacyFloorSurface = 0.92 - legacyFloor * 0.58;
  const surface = normalized < legacyFloor
    ? 0.99 - ((normalized - MIN_BACKGROUND_STRENGTH) / (legacyFloor - MIN_BACKGROUND_STRENGTH))
      * (0.99 - legacyFloorSurface)
    : 0.92 - normalized * 0.58;
  const clampedSurface = clampNumber(surface, 0.42, 0.99);
  return {
    surface: clampedSurface,
    panel: clampNumber(clampedSurface + 0.1, 0.5, 0.99),
  };
}

export function isImageFile(file: Pick<File, "name" | "type">): boolean {
  const supportedTypes = new Set([
    "image/avif",
    "image/bmp",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
  ]);
  if (file.type && supportedTypes.has(file.type.toLowerCase())) return true;
  return /\.(avif|bmp|gif|jpe?g|png|webp)$/i.test(file.name);
}

export function isAudioFile(file: Pick<File, "name" | "type">): boolean {
  if (file.type.startsWith("audio/")) return true;
  return /\.(aac|flac|m4a|mp3|oga|ogg|opus|wav|webm)$/i.test(file.name);
}
