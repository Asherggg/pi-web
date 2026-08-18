"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  COMPLETION_SOUND_ASSET_KEY,
  MAX_CUSTOM_SOUND_SECONDS,
  MAX_SOUND_FILE_BYTES,
  SOUND_CUSTOM_NAME_KEY,
  SOUND_PRESET_KEY,
  SOUND_VOLUME_KEY,
  isAudioFile,
  parseSoundPreset,
  parseSoundVolume,
  type BuiltInSoundPreset,
  type SoundPreset,
} from "@/lib/personalization";
import {
  deletePersonalizationAsset,
  loadPersonalizationAsset,
  savePersonalizationAsset,
} from "@/lib/personalization-storage";
import { decodePcmWav } from "@/lib/wav-decoder";

export type SoundUploadError = "invalid-type" | "too-large" | "too-long" | "decode" | "storage";

export interface AudioController {
  soundEnabled: boolean;
  soundPreset: SoundPreset;
  soundVolume: number;
  customSoundName: string | null;
  customSoundReady: boolean;
  onSoundToggle: () => void;
  setSoundPreset: (preset: SoundPreset) => void;
  setSoundVolume: (volume: number) => void;
  setCustomSoundFile: (file: File) => Promise<void>;
  removeCustomSound: () => Promise<void>;
  playDoneSound: () => void;
  previewDoneSound: () => void;
  unlockAudio: (force?: boolean) => void;
  soundEnabledRef: React.RefObject<boolean>;
}

interface ToneNote {
  frequency: number;
  offset: number;
  duration: number;
  gain: number;
  type: OscillatorType;
}

const TONES: Record<BuiltInSoundPreset, readonly ToneNote[]> = {
  classic: [
    { frequency: 523.25, offset: 0, duration: 0.45, gain: 0.18, type: "sine" },
    { frequency: 659.25, offset: 0.18, duration: 0.45, gain: 0.18, type: "sine" },
  ],
  soft: [
    { frequency: 392, offset: 0, duration: 0.55, gain: 0.12, type: "sine" },
    { frequency: 523.25, offset: 0.24, duration: 0.62, gain: 0.11, type: "sine" },
  ],
  bright: [
    { frequency: 659.25, offset: 0, duration: 0.28, gain: 0.11, type: "triangle" },
    { frequency: 783.99, offset: 0.12, duration: 0.3, gain: 0.1, type: "triangle" },
    { frequency: 1046.5, offset: 0.24, duration: 0.36, gain: 0.09, type: "triangle" },
  ],
};

function readBooleanPreference(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const stored = window.localStorage.getItem(key);
    return stored === null ? fallback : stored === "true";
  } catch {
    return fallback;
  }
}

function readStringPreference(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storePreference(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // The current page keeps working when persistent storage is unavailable.
  }
}

function playTone(ctx: AudioContext, preset: BuiltInSoundPreset, volume: number): void {
  if (volume <= 0) return;
  const now = ctx.currentTime;

  for (const note of TONES[preset]) {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.type = note.type;
    oscillator.frequency.value = note.frequency;

    const start = now + note.offset;
    const peak = Math.max(0.0001, note.gain * volume);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(peak, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + note.duration);
    oscillator.start(start);
    oscillator.stop(start + note.duration);
  }
}

function playBuffer(ctx: AudioContext, buffer: AudioBuffer, volume: number): void {
  if (volume <= 0) return;
  const source = ctx.createBufferSource();
  const gain = ctx.createGain();
  source.buffer = buffer;
  gain.gain.value = volume;
  source.connect(gain);
  gain.connect(ctx.destination);
  source.start();
}

async function decodeAudioDataWithPcmFallback(ctx: AudioContext, arrayBuffer: ArrayBuffer): Promise<AudioBuffer> {
  try {
    // decodeAudioData may detach its input, so keep the original buffer for the
    // manual PCM fallback.
    return await ctx.decodeAudioData(arrayBuffer.slice(0));
  } catch (nativeError) {
    const decoded = decodePcmWav(arrayBuffer);
    if (!decoded) throw nativeError;

    const audioBuffer = ctx.createBuffer(decoded.channels, decoded.frames, decoded.sampleRate);
    decoded.channelData.forEach((channel, index) => {
      audioBuffer.getChannelData(index).set(channel);
    });
    return audioBuffer;
  }
}

export function useAudio(): AudioController {
  const [enabled, setEnabled] = useState<boolean>(() => readBooleanPreference("pi-sound-enabled", true));
  const [soundPreset, setSoundPresetState] = useState<SoundPreset>(() => (
    parseSoundPreset(readStringPreference(SOUND_PRESET_KEY))
  ));
  const [soundVolume, setSoundVolumeState] = useState<number>(() => (
    parseSoundVolume(readStringPreference(SOUND_VOLUME_KEY))
  ));
  const [customSoundName, setCustomSoundName] = useState<string | null>(() => (
    readStringPreference(SOUND_CUSTOM_NAME_KEY)
  ));
  const [customSoundReady, setCustomSoundReady] = useState(false);

  const enabledRef = useRef(enabled);
  const presetRef = useRef(soundPreset);
  const volumeRef = useRef(soundVolume);
  const customBufferRef = useRef<AudioBuffer | null>(null);
  const customOperationRef = useRef(0);

  useEffect(() => { enabledRef.current = enabled; }, [enabled]);
  useEffect(() => { presetRef.current = soundPreset; }, [soundPreset]);
  useEffect(() => { volumeRef.current = soundVolume; }, [soundVolume]);

  const ctxRef = useRef<AudioContext | null>(null);
  const getCtx = useCallback((): AudioContext | null => {
    if (ctxRef.current && ctxRef.current.state !== "closed") return ctxRef.current;
    try {
      ctxRef.current = new AudioContext();
    } catch {
      return null;
    }
    return ctxRef.current;
  }, []);

  useEffect(() => {
    const operation = ++customOperationRef.current;
    void loadPersonalizationAsset(COMPLETION_SOUND_ASSET_KEY)
      .then(async (stored) => {
        if (operation !== customOperationRef.current) return;
        if (!stored) {
          customBufferRef.current = null;
          setCustomSoundReady(false);
          setCustomSoundName(null);
          storePreference(SOUND_CUSTOM_NAME_KEY, null);
          if (presetRef.current === "custom") {
            presetRef.current = "classic";
            setSoundPresetState("classic");
            storePreference(SOUND_PRESET_KEY, "classic");
          }
          return;
        }

        const ctx = getCtx();
        if (!ctx) return;
        const buffer = await decodeAudioDataWithPcmFallback(ctx, await stored.blob.arrayBuffer());
        if (operation !== customOperationRef.current) return;
        customBufferRef.current = buffer;
        setCustomSoundReady(true);
        setCustomSoundName(stored.name);
        storePreference(SOUND_CUSTOM_NAME_KEY, stored.name);
      })
      .catch(() => {
        if (operation !== customOperationRef.current) return;
        customBufferRef.current = null;
        setCustomSoundReady(false);
      });

    return () => {
      customOperationRef.current += 1;
    };
  }, [getCtx]);

  const unlockAudio = useCallback((force = false) => {
    if (!force && !enabledRef.current) return;
    const ctx = getCtx();
    if (!ctx || ctx.state !== "suspended") return;
    void ctx.resume().catch(() => {});
  }, [getCtx]);

  const toggle = useCallback(() => {
    const next = !enabledRef.current;
    if (next) unlockAudio(true);
    enabledRef.current = next;
    storePreference("pi-sound-enabled", String(next));
    setEnabled(next);
  }, [unlockAudio]);

  const playSelectedSound = useCallback((force: boolean) => {
    if (!force && !enabledRef.current) return;
    const ctx = getCtx();
    if (!ctx) return;

    const play = () => {
      try {
        const preset = presetRef.current;
        const volume = volumeRef.current;
        if (preset === "custom" && customBufferRef.current) {
          playBuffer(ctx, customBufferRef.current, volume);
        } else {
          playTone(ctx, preset === "custom" ? "classic" : preset, volume);
        }
      } catch {
        // Audio APIs can become unavailable when a tab or device is suspended.
      }
    };

    if (ctx.state === "suspended") {
      void ctx.resume().then(play).catch(() => {});
      return;
    }
    play();
  }, [getCtx]);

  const setSoundPreset = useCallback((preset: SoundPreset) => {
    if (preset === "custom" && !customBufferRef.current) return;
    presetRef.current = preset;
    setSoundPresetState(preset);
    storePreference(SOUND_PRESET_KEY, preset);
  }, []);

  const setSoundVolume = useCallback((volume: number) => {
    const next = Math.min(1, Math.max(0, volume));
    volumeRef.current = next;
    setSoundVolumeState(next);
    storePreference(SOUND_VOLUME_KEY, String(next));
  }, []);

  const setCustomSoundFile = useCallback(async (file: File) => {
    if (!isAudioFile(file)) throw new Error("invalid-type" satisfies SoundUploadError);
    if (file.size > MAX_SOUND_FILE_BYTES) throw new Error("too-large" satisfies SoundUploadError);

    const ctx = getCtx();
    if (!ctx) throw new Error("decode" satisfies SoundUploadError);
    unlockAudio(true);
    const operation = ++customOperationRef.current;

    let buffer: AudioBuffer;
    try {
      buffer = await decodeAudioDataWithPcmFallback(ctx, await file.arrayBuffer());
    } catch {
      throw new Error("decode" satisfies SoundUploadError);
    }
    if (buffer.duration > MAX_CUSTOM_SOUND_SECONDS) {
      throw new Error("too-long" satisfies SoundUploadError);
    }

    try {
      await savePersonalizationAsset(COMPLETION_SOUND_ASSET_KEY, file, file.name);
    } catch {
      throw new Error("storage" satisfies SoundUploadError);
    }
    if (operation !== customOperationRef.current) return;

    customBufferRef.current = buffer;
    setCustomSoundReady(true);
    setCustomSoundName(file.name);
    storePreference(SOUND_CUSTOM_NAME_KEY, file.name);
    presetRef.current = "custom";
    setSoundPresetState("custom");
    storePreference(SOUND_PRESET_KEY, "custom");
    if (!enabledRef.current) toggle();
  }, [getCtx, toggle, unlockAudio]);

  const removeCustomSound = useCallback(async () => {
    const operation = ++customOperationRef.current;
    try {
      await deletePersonalizationAsset(COMPLETION_SOUND_ASSET_KEY);
    } catch {
      throw new Error("storage" satisfies SoundUploadError);
    }
    if (operation !== customOperationRef.current) return;

    customBufferRef.current = null;
    setCustomSoundReady(false);
    setCustomSoundName(null);
    storePreference(SOUND_CUSTOM_NAME_KEY, null);
    if (presetRef.current === "custom") {
      presetRef.current = "classic";
      setSoundPresetState("classic");
      storePreference(SOUND_PRESET_KEY, "classic");
    }
  }, []);

  const playDone = useCallback(() => playSelectedSound(false), [playSelectedSound]);
  const previewDone = useCallback(() => playSelectedSound(true), [playSelectedSound]);

  return {
    soundEnabled: enabled,
    soundPreset,
    soundVolume,
    customSoundName,
    customSoundReady,
    onSoundToggle: toggle,
    setSoundPreset,
    setSoundVolume,
    setCustomSoundFile,
    removeCustomSound,
    playDoneSound: playDone,
    previewDoneSound: previewDone,
    unlockAudio,
    soundEnabledRef: enabledRef,
  };
}
