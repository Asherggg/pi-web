"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { BackgroundController, BackgroundUploadError } from "@/hooks/useBackground";
import type { AudioController, SoundUploadError } from "@/hooks/useAudio";
import type { SoundPreset } from "@/lib/personalization";

interface Props {
  background: BackgroundController;
  audio: AudioController;
  onClose: () => void;
}

const iconButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 32,
  height: 32,
  padding: 0,
  border: "none",
  borderRadius: 5,
  background: "transparent",
  color: "var(--text-muted)",
  cursor: "pointer",
};

const actionButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 32,
  gap: 6,
  padding: "0 11px",
  border: "1px solid var(--border)",
  borderRadius: 5,
  background: "var(--bg-panel)",
  color: "var(--text)",
  cursor: "pointer",
  fontSize: 12,
  whiteSpace: "nowrap",
};

function SectionHeading({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text)" }}>
      <span style={{ display: "flex", color: "var(--text-muted)" }}>{icon}</span>
      <h2 style={{ margin: 0, fontSize: 13, fontWeight: 650, letterSpacing: 0 }}>{title}</h2>
    </div>
  );
}

function Segment<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly { value: T; label: string; disabled?: boolean }[];
  onChange: (value: T) => void;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))`, border: "1px solid var(--border)", borderRadius: 5, overflow: "hidden" }}>
      {options.map((option, index) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            disabled={option.disabled}
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            style={{
              minWidth: 0,
              height: 32,
              padding: "0 8px",
              border: "none",
              borderLeft: index ? "1px solid var(--border)" : "none",
              background: active ? "var(--bg-selected)" : "transparent",
              color: option.disabled ? "var(--text-dim)" : active ? "var(--text)" : "var(--text-muted)",
              cursor: option.disabled ? "not-allowed" : "pointer",
              fontSize: 11,
              fontWeight: active ? 600 : 400,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function errorKey(prefix: "background" | "sound", error: unknown): string {
  const code = error instanceof Error ? error.message : "storage";
  const knownBackground: readonly BackgroundUploadError[] = ["invalid-type", "too-large", "storage"];
  const knownSound: readonly SoundUploadError[] = ["invalid-type", "too-large", "too-long", "decode", "storage"];
  const known = prefix === "background" ? knownBackground : knownSound;
  return `personalization.${prefix}Error.${known.includes(code as never) ? code : "storage"}`;
}

export function PersonalizationConfig({ background, audio, onClose }: Props) {
  const { t } = useI18n();
  const imageInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [backgroundError, setBackgroundError] = useState<string | null>(null);
  const [soundError, setSoundError] = useState<string | null>(null);
  const [backgroundBusy, setBackgroundBusy] = useState(false);
  const [soundBusy, setSoundBusy] = useState(false);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleBackgroundFile = async (file: File | undefined) => {
    if (!file) return;
    setBackgroundError(null);
    setBackgroundBusy(true);
    try {
      await background.setBackgroundFile(file);
    } catch (error) {
      setBackgroundError(t(errorKey("background", error)));
    } finally {
      setBackgroundBusy(false);
      if (imageInputRef.current) imageInputRef.current.value = "";
    }
  };

  const handleRemoveBackground = async () => {
    setBackgroundError(null);
    setBackgroundBusy(true);
    try {
      await background.removeBackground();
    } catch (error) {
      setBackgroundError(t(errorKey("background", error)));
    } finally {
      setBackgroundBusy(false);
    }
  };

  const handleSoundFile = async (file: File | undefined) => {
    if (!file) return;
    setSoundError(null);
    setSoundBusy(true);
    try {
      await audio.setCustomSoundFile(file);
      audio.previewDoneSound();
    } catch (error) {
      setSoundError(t(errorKey("sound", error)));
    } finally {
      setSoundBusy(false);
      if (audioInputRef.current) audioInputRef.current.value = "";
    }
  };

  const handleRemoveSound = async () => {
    setSoundError(null);
    setSoundBusy(true);
    try {
      await audio.removeCustomSound();
    } catch (error) {
      setSoundError(t(errorKey("sound", error)));
    } finally {
      setSoundBusy(false);
    }
  };

  const soundOptions: readonly { value: SoundPreset; label: string; disabled?: boolean }[] = [
    { value: "classic", label: t("personalization.soundClassic") },
    { value: "soft", label: t("personalization.soundSoft") },
    { value: "bright", label: t("personalization.soundBright") },
    { value: "custom", label: t("personalization.soundCustom"), disabled: !audio.customSoundReady },
  ];

  return (
    <div
      role="presentation"
      className="personalization-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <style>{`
        .personalization-overlay {
          position: fixed;
          inset: 0;
          z-index: 1100;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 16px;
          background: rgba(0, 0, 0, 0.46);
        }
        .personalization-dialog {
          width: min(720px, 100%);
          max-height: min(760px, calc(100dvh - 32px));
          overflow: hidden;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: color-mix(in srgb, var(--bg) 94%, var(--bg-panel));
          box-shadow: 0 16px 44px rgba(0, 0, 0, 0.28);
          backdrop-filter: blur(18px);
        }
        .personalization-body {
          max-height: calc(100dvh - 126px);
          overflow-y: auto;
        }
        .personalization-background-grid {
          display: grid;
          grid-template-columns: minmax(0, 220px) minmax(260px, 1fr);
          gap: 18px;
          align-items: start;
        }
        .personalization-audio-grid {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 12px;
          align-items: end;
        }
        @media (max-width: 600px) {
          .personalization-overlay { padding: 0; align-items: stretch; }
          .personalization-dialog {
            display: flex;
            flex-direction: column;
            width: 100%;
            height: 100dvh;
            max-height: 100dvh;
            border-radius: 0;
            border-width: 0;
          }
          .personalization-body { flex: 1; max-height: none; }
          .personalization-background-grid,
          .personalization-audio-grid { grid-template-columns: minmax(0, 1fr); }
        }
      `}</style>
      <div
        className="personalization-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="personalization-title"
      >
        <header style={{ display: "flex", alignItems: "center", minHeight: 48, gap: 10, padding: "0 12px 0 16px", borderBottom: "1px solid var(--border)" }}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: "var(--text-muted)" }}>
            <path d="M4 21v-7" /><path d="M4 10V3" /><path d="M12 21v-9" /><path d="M12 8V3" /><path d="M20 21v-5" /><path d="M20 12V3" />
            <path d="M1 14h6" /><path d="M9 8h6" /><path d="M17 16h6" />
          </svg>
          <h1 id="personalization-title" style={{ flex: 1, margin: 0, fontSize: 14, fontWeight: 650, letterSpacing: 0 }}>
            {t("personalization.title")}
          </h1>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            title={t("i18n.close")}
            aria-label={t("i18n.close")}
            style={iconButtonStyle}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M5 5l14 14M19 5 5 19" />
            </svg>
          </button>
        </header>

        <div className="personalization-body">
          <section style={{ padding: 18 }} aria-labelledby="personalization-background-heading">
            <div id="personalization-background-heading">
              <SectionHeading
                title={t("personalization.background")}
                icon={(
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9" r="1.5" /><path d="m21 15-5-5L5 20" />
                  </svg>
                )}
              />
            </div>

            <div className="personalization-background-grid" style={{ marginTop: 14 }}>
              <div
                style={{
                  position: "relative",
                  aspectRatio: "16 / 10",
                  overflow: "hidden",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  backgroundColor: "var(--bg-panel)",
                  backgroundImage: background.backgroundUrl ? `url("${background.backgroundUrl}")` : undefined,
                  backgroundPosition: "center",
                  backgroundRepeat: "no-repeat",
                  backgroundSize: background.backgroundFit,
                }}
              >
                {!background.backgroundUrl && (
                  <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 7, color: "var(--text-dim)", fontSize: 11 }}>
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9" r="1.5" /><path d="m21 15-5-5L5 20" />
                    </svg>
                    <span>{background.backgroundLoading ? t("i18n.loading") : t("personalization.noBackground")}</span>
                  </div>
                )}
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 13, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp"
                    hidden
                    onChange={(event) => void handleBackgroundFile(event.target.files?.[0])}
                  />
                  <button
                    type="button"
                    disabled={backgroundBusy || background.backgroundLoading}
                    onClick={() => imageInputRef.current?.click()}
                    style={{ ...actionButtonStyle, opacity: backgroundBusy || background.backgroundLoading ? 0.55 : 1 }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 16V4M7 9l5-5 5 5" /><path d="M5 20h14" />
                    </svg>
                    {background.backgroundUrl ? t("personalization.replaceImage") : t("personalization.uploadImage")}
                  </button>
                  {background.backgroundUrl && (
                    <button
                      type="button"
                      disabled={backgroundBusy}
                      onClick={() => void handleRemoveBackground()}
                      title={t("personalization.removeImage")}
                      aria-label={t("personalization.removeImage")}
                      style={{ ...iconButtonStyle, color: "#ef4444", opacity: backgroundBusy ? 0.55 : 1 }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 10v6M14 10v6" />
                      </svg>
                    </button>
                  )}
                  <span title={background.backgroundName ?? undefined} style={{ minWidth: 0, overflow: "hidden", color: "var(--text-dim)", fontSize: 11, textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {background.backgroundName}
                  </span>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <label style={{ display: "flex", justifyContent: "space-between", gap: 12, color: "var(--text-muted)", fontSize: 11 }}>
                    <span>{t("personalization.imageVisibility")}</span>
                    <span>{Math.round(background.backgroundStrength * 100)}%</span>
                  </label>
                  <input
                    type="range"
                    min="20"
                    max="80"
                    step="1"
                    value={Math.round(background.backgroundStrength * 100)}
                    aria-label={t("personalization.imageVisibility")}
                    onChange={(event) => background.setBackgroundStrength(Number(event.target.value) / 100)}
                    style={{ width: "100%", accentColor: "var(--accent)" }}
                  />
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{t("personalization.imageFit")}</span>
                  <Segment
                    value={background.backgroundFit}
                    options={[
                      { value: "cover", label: t("personalization.fitCover") },
                      { value: "contain", label: t("personalization.fitContain") },
                    ]}
                    onChange={background.setBackgroundFit}
                  />
                </div>
              </div>
            </div>
            {backgroundError && <div role="alert" style={{ marginTop: 10, color: "#ef4444", fontSize: 11 }}>{backgroundError}</div>}
          </section>

          <section style={{ padding: 18, borderTop: "1px solid var(--border)" }} aria-labelledby="personalization-sound-heading">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <div id="personalization-sound-heading">
                <SectionHeading
                  title={t("personalization.completionSound")}
                  icon={(
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M11 5 6 9H3v6h3l5 4V5Z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M19 5a10 10 0 0 1 0 14" />
                    </svg>
                  )}
                />
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={audio.soundEnabled}
                aria-label={audio.soundEnabled ? t("chat.disableSound") : t("chat.enableSound")}
                title={audio.soundEnabled ? t("chat.disableSound") : t("chat.enableSound")}
                onClick={audio.onSoundToggle}
                style={{
                  position: "relative",
                  width: 38,
                  height: 22,
                  padding: 0,
                  border: "1px solid var(--border)",
                  borderRadius: 11,
                  background: audio.soundEnabled ? "var(--accent)" : "var(--bg-selected)",
                  cursor: "pointer",
                  transition: "background 0.15s",
                }}
              >
                <span style={{ position: "absolute", top: 3, left: audio.soundEnabled ? 19 : 3, width: 14, height: 14, borderRadius: "50%", background: "white", boxShadow: "0 1px 3px rgba(0,0,0,0.28)", transition: "left 0.15s" }} />
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 14, opacity: audio.soundEnabled ? 1 : 0.58 }}>
              <Segment value={audio.soundPreset} options={soundOptions} onChange={audio.setSoundPreset} />

              <div className="personalization-audio-grid">
                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <input
                    ref={audioInputRef}
                    type="file"
                    accept="audio/mpeg,audio/mp4,audio/ogg,audio/wav,audio/webm,audio/flac,audio/aac"
                    hidden
                    onChange={(event) => void handleSoundFile(event.target.files?.[0])}
                  />
                  <button
                    type="button"
                    disabled={soundBusy}
                    onClick={() => {
                      audio.unlockAudio(true);
                      audioInputRef.current?.click();
                    }}
                    style={{ ...actionButtonStyle, opacity: soundBusy ? 0.55 : 1 }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M9 18V5l10-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="16" cy="16" r="3" />
                    </svg>
                    {audio.customSoundName ? t("personalization.replaceSound") : t("personalization.uploadSound")}
                  </button>
                  {audio.customSoundName && (
                    <button
                      type="button"
                      disabled={soundBusy}
                      onClick={() => void handleRemoveSound()}
                      title={t("personalization.removeSound")}
                      aria-label={t("personalization.removeSound")}
                      style={{ ...iconButtonStyle, color: "#ef4444", opacity: soundBusy ? 0.55 : 1 }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 10v6M14 10v6" />
                      </svg>
                    </button>
                  )}
                  <span title={audio.customSoundName ?? undefined} style={{ minWidth: 0, overflow: "hidden", color: "var(--text-dim)", fontSize: 11, textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {audio.customSoundName}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    audio.unlockAudio(true);
                    audio.previewDoneSound();
                  }}
                  style={actionButtonStyle}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m8 5 11 7-11 7V5Z" /></svg>
                  {t("personalization.previewSound")}
                </button>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ display: "flex", justifyContent: "space-between", gap: 12, color: "var(--text-muted)", fontSize: 11 }}>
                  <span>{t("personalization.volume")}</span>
                  <span>{Math.round(audio.soundVolume * 100)}%</span>
                </label>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={Math.round(audio.soundVolume * 100)}
                  aria-label={t("personalization.volume")}
                  onChange={(event) => audio.setSoundVolume(Number(event.target.value) / 100)}
                  style={{ width: "100%", accentColor: "var(--accent)" }}
                />
              </div>
            </div>
            {soundError && <div role="alert" style={{ marginTop: 10, color: "#ef4444", fontSize: 11 }}>{soundError}</div>}
          </section>
        </div>

        <footer style={{ display: "flex", justifyContent: "flex-end", padding: "9px 14px", borderTop: "1px solid var(--border)" }}>
          <button type="button" onClick={onClose} style={actionButtonStyle}>{t("i18n.close")}</button>
        </footer>
      </div>
    </div>
  );
}
