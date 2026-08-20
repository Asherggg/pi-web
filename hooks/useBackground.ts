"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BACKGROUND_ASSET_KEY,
  BACKGROUND_PREFERENCES_KEY,
  DEFAULT_BACKGROUND_PREFERENCES,
  MAX_BACKGROUND_FILE_BYTES,
  MAX_BACKGROUND_STRENGTH,
  MIN_BACKGROUND_STRENGTH,
  getBackgroundSurfaceAlphas,
  isImageFile,
  parseBackgroundPreferences,
  type BackgroundFit,
  type BackgroundPreferences,
} from "@/lib/personalization";
import {
  deletePersonalizationAsset,
  loadPersonalizationAsset,
  savePersonalizationAsset,
} from "@/lib/personalization-storage";

export type BackgroundUploadError = "invalid-type" | "too-large" | "storage";

export interface BackgroundController {
  backgroundUrl: string | null;
  backgroundName: string | null;
  backgroundStrength: number;
  backgroundFit: BackgroundFit;
  backgroundLoading: boolean;
  setBackgroundFile: (file: File) => Promise<void>;
  removeBackground: () => Promise<void>;
  setBackgroundStrength: (strength: number) => void;
  setBackgroundFit: (fit: BackgroundFit) => void;
}

function readPreferences(): BackgroundPreferences {
  if (typeof window === "undefined") return DEFAULT_BACKGROUND_PREFERENCES;
  try {
    return parseBackgroundPreferences(window.localStorage.getItem(BACKGROUND_PREFERENCES_KEY));
  } catch {
    return DEFAULT_BACKGROUND_PREFERENCES;
  }
}

export function useBackground(): BackgroundController {
  const [preferences, setPreferences] = useState<BackgroundPreferences>(readPreferences);
  const [backgroundUrl, setBackgroundUrl] = useState<string | null>(null);
  const [backgroundLoading, setBackgroundLoading] = useState(true);
  const objectUrlRef = useRef<string | null>(null);
  const operationRef = useRef(0);

  const replaceObjectUrl = useCallback((next: string | null) => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = next;
    setBackgroundUrl(next);
  }, []);

  useEffect(() => {
    const operation = ++operationRef.current;
    void loadPersonalizationAsset(BACKGROUND_ASSET_KEY)
      .then((stored) => {
        if (operation !== operationRef.current) return;
        if (!stored) {
          replaceObjectUrl(null);
          setPreferences((current) => current.assetName
            ? { ...current, assetName: null }
            : current);
          return;
        }
        replaceObjectUrl(URL.createObjectURL(stored.blob));
        setPreferences((current) => current.assetName === stored.name
          ? current
          : { ...current, assetName: stored.name });
      })
      .catch(() => {
        if (operation === operationRef.current) replaceObjectUrl(null);
      })
      .finally(() => {
        if (operation === operationRef.current) setBackgroundLoading(false);
      });

    return () => {
      operationRef.current += 1;
    };
  }, [replaceObjectUrl]);

  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(BACKGROUND_PREFERENCES_KEY, JSON.stringify(preferences));
    } catch {
      // The current page still keeps the selected preferences when storage is unavailable.
    }
  }, [preferences]);

  useEffect(() => {
    const root = document.documentElement;
    const active = Boolean(backgroundUrl);
    root.classList.toggle("has-custom-background", active);

    if (!active || !backgroundUrl) {
      root.style.removeProperty("--app-background-image");
      root.style.removeProperty("--app-background-size");
      root.style.removeProperty("--app-surface-alpha");
      root.style.removeProperty("--app-panel-alpha");
      return;
    }

    const { surface, panel } = getBackgroundSurfaceAlphas(preferences.strength);
    root.style.setProperty("--app-background-image", `url("${backgroundUrl}")`);
    root.style.setProperty("--app-background-size", preferences.fit);
    root.style.setProperty("--app-surface-alpha", surface.toFixed(3));
    root.style.setProperty("--app-panel-alpha", panel.toFixed(3));

    return () => {
      root.classList.remove("has-custom-background");
      root.style.removeProperty("--app-background-image");
      root.style.removeProperty("--app-background-size");
      root.style.removeProperty("--app-surface-alpha");
      root.style.removeProperty("--app-panel-alpha");
    };
  }, [backgroundUrl, preferences.fit, preferences.strength]);

  const setBackgroundFile = useCallback(async (file: File) => {
    if (!isImageFile(file)) throw new Error("invalid-type" satisfies BackgroundUploadError);
    if (file.size > MAX_BACKGROUND_FILE_BYTES) throw new Error("too-large" satisfies BackgroundUploadError);

    const operation = ++operationRef.current;
    setBackgroundLoading(true);
    try {
      await savePersonalizationAsset(BACKGROUND_ASSET_KEY, file, file.name);
      if (operation !== operationRef.current) return;
      replaceObjectUrl(URL.createObjectURL(file));
      setPreferences((current) => ({ ...current, assetName: file.name }));
    } catch (error) {
      if (error instanceof Error && (error.message === "invalid-type" || error.message === "too-large")) {
        throw error;
      }
      throw new Error("storage" satisfies BackgroundUploadError);
    } finally {
      if (operation === operationRef.current) setBackgroundLoading(false);
    }
  }, [replaceObjectUrl]);

  const removeBackground = useCallback(async () => {
    const operation = ++operationRef.current;
    setBackgroundLoading(true);
    try {
      await deletePersonalizationAsset(BACKGROUND_ASSET_KEY);
      if (operation !== operationRef.current) return;
      replaceObjectUrl(null);
      setPreferences((current) => ({ ...current, assetName: null }));
    } catch {
      throw new Error("storage" satisfies BackgroundUploadError);
    } finally {
      if (operation === operationRef.current) setBackgroundLoading(false);
    }
  }, [replaceObjectUrl]);

  const setBackgroundStrength = useCallback((strength: number) => {
    setPreferences((current) => ({
      ...current,
      strength: Math.min(MAX_BACKGROUND_STRENGTH, Math.max(MIN_BACKGROUND_STRENGTH, strength)),
    }));
  }, []);

  const setBackgroundFit = useCallback((fit: BackgroundFit) => {
    setPreferences((current) => ({ ...current, fit }));
  }, []);

  return {
    backgroundUrl,
    backgroundName: preferences.assetName,
    backgroundStrength: preferences.strength,
    backgroundFit: preferences.fit,
    backgroundLoading,
    setBackgroundFile,
    removeBackground,
    setBackgroundStrength,
    setBackgroundFit,
  };
}
