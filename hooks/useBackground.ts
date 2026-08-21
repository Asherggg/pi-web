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

const BACKGROUND_API = "/api/personalization/background";

function readPreferences(): BackgroundPreferences {
  if (typeof window === "undefined") return DEFAULT_BACKGROUND_PREFERENCES;
  try {
    return parseBackgroundPreferences(window.localStorage.getItem(BACKGROUND_PREFERENCES_KEY));
  } catch {
    return DEFAULT_BACKGROUND_PREFERENCES;
  }
}

function imageType(file: File): string {
  if (file.type) return file.type.toLowerCase();
  const extension = file.name.split(".").pop()?.toLowerCase();
  return extension === "avif" ? "image/avif"
    : extension === "bmp" ? "image/bmp"
    : extension === "gif" ? "image/gif"
    : extension === "jpg" || extension === "jpeg" ? "image/jpeg"
    : extension === "png" ? "image/png"
    : extension === "webp" ? "image/webp"
    : "";
}

function preferencesFromResponse(
  response: Response,
  fallback: BackgroundPreferences,
  assetName: string,
): BackgroundPreferences {
  const parsedStrength = Number(response.headers.get("x-pi-background-strength"));
  const strength = Number.isFinite(parsedStrength)
    ? Math.min(MAX_BACKGROUND_STRENGTH, Math.max(MIN_BACKGROUND_STRENGTH, parsedStrength))
    : fallback.strength;
  const fitHeader = response.headers.get("x-pi-background-fit");
  const fit = fitHeader === "cover" || fitHeader === "contain" ? fitHeader : fallback.fit;
  return { strength, fit, assetName };
}

async function uploadBackground(file: Blob, name: string, preferences: BackgroundPreferences): Promise<void> {
  const response = await fetch(BACKGROUND_API, {
    method: "PUT",
    headers: {
      "Content-Type": file.type,
      "X-Pi-Background-Name": encodeURIComponent(name),
      "X-Pi-Background-Strength": String(preferences.strength),
      "X-Pi-Background-Fit": preferences.fit,
    },
    body: file,
  });
  if (!response.ok) throw new Error("storage");
}

export function useBackground(): BackgroundController {
  const [preferences, setPreferences] = useState<BackgroundPreferences>(readPreferences);
  const [backgroundUrl, setBackgroundUrl] = useState<string | null>(null);
  const [backgroundLoading, setBackgroundLoading] = useState(true);
  const objectUrlRef = useRef<string | null>(null);
  const operationRef = useRef(0);
  const loadedRef = useRef(false);
  const preferencesRef = useRef(preferences);

  const replaceObjectUrl = useCallback((next: string | null) => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = next;
    setBackgroundUrl(next);
  }, []);

  useEffect(() => {
    preferencesRef.current = preferences;
  }, [preferences]);

  useEffect(() => {
    const operation = ++operationRef.current;
    void fetch(BACKGROUND_API, { cache: "no-store" })
      .then(async (response) => {
        if (operation !== operationRef.current) return;
        if (response.ok) {
          const blob = await response.blob();
          if (operation !== operationRef.current) return;
          const encodedName = response.headers.get("x-pi-background-name");
          const name = encodedName ? decodeURIComponent(encodedName) : "background";
          replaceObjectUrl(URL.createObjectURL(blob));
          setPreferences((current) => preferencesFromResponse(response, current, name));
          void deletePersonalizationAsset(BACKGROUND_ASSET_KEY).catch(() => {});
          return;
        }
        if (response.status !== 404) throw new Error("Unable to load background");

        // One-time migration for backgrounds saved by versions that only used
        // origin-scoped IndexedDB. The server copy becomes authoritative.
        const legacy = await loadPersonalizationAsset(BACKGROUND_ASSET_KEY);
        if (operation !== operationRef.current) return;
        if (!legacy) {
          replaceObjectUrl(null);
          setPreferences((current) => current.assetName
            ? { ...current, assetName: null }
            : current);
          return;
        }
        const migratedBlob = legacy.blob.type
          ? legacy.blob
          : legacy.blob.slice(0, legacy.blob.size, imageType(new File([], legacy.name)));
        await uploadBackground(migratedBlob, legacy.name, preferencesRef.current);
        if (operation !== operationRef.current) return;
        replaceObjectUrl(URL.createObjectURL(migratedBlob));
        setPreferences((current) => ({ ...current, assetName: legacy.name }));
        void deletePersonalizationAsset(BACKGROUND_ASSET_KEY).catch(() => {});
      })
      .catch(() => {
        if (operation === operationRef.current) replaceObjectUrl(null);
      })
      .finally(() => {
        if (operation === operationRef.current) {
          loadedRef.current = true;
          setBackgroundLoading(false);
        }
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
    if (!loadedRef.current || !backgroundUrl) return;
    const timeout = window.setTimeout(() => {
      void fetch(BACKGROUND_API, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strength: preferences.strength, fit: preferences.fit }),
      }).catch(() => {});
    }, 200);
    return () => window.clearTimeout(timeout);
  }, [backgroundUrl, preferences.fit, preferences.strength]);

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
      const normalizedFile = file.type
        ? file
        : file.slice(0, file.size, imageType(file));
      await uploadBackground(normalizedFile, file.name, preferencesRef.current);
      if (operation !== operationRef.current) return;
      replaceObjectUrl(URL.createObjectURL(normalizedFile));
      setPreferences((current) => ({ ...current, assetName: file.name }));
      void deletePersonalizationAsset(BACKGROUND_ASSET_KEY).catch(() => {});
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
      const response = await fetch(BACKGROUND_API, { method: "DELETE" });
      if (!response.ok) throw new Error("storage");
      await deletePersonalizationAsset(BACKGROUND_ASSET_KEY).catch(() => {});
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
