import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateBufferAtomicSync } from "./atomic-file";
import {
  DEFAULT_BACKGROUND_PREFERENCES,
  MAX_BACKGROUND_FILE_BYTES,
  MAX_BACKGROUND_STRENGTH,
  MIN_BACKGROUND_STRENGTH,
  type BackgroundFit,
} from "./personalization";

const PERSONALIZATION_DIRECTORY = "pi-web";
const BACKGROUND_FILE = "background-image";
const LEGACY_BACKGROUND_METADATA_FILE = "background-image.json";
const CONTAINER_MAGIC = Buffer.from("PIBG1\0", "ascii");
const METADATA_LENGTH_BYTES = 4;
const MAX_METADATA_BYTES = 16 * 1024;

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export interface StoredBackgroundMetadata {
  name: string;
  type: string;
  size: number;
  updatedAt: number;
  strength: number;
  fit: BackgroundFit;
}

export interface StoredBackground {
  bytes: Buffer;
  metadata: StoredBackgroundMetadata;
}

export class InvalidBackgroundError extends Error {}

export class BackgroundTooLargeError extends Error {}

export function getPersonalizationDirectory(agentDir = getAgentDir()): string {
  return join(agentDir, PERSONALIZATION_DIRECTORY);
}

function getBackgroundPath(agentDir = getAgentDir()): string {
  return join(getPersonalizationDirectory(agentDir), BACKGROUND_FILE);
}

function matchesImageType(bytes: Uint8Array, type: string): boolean {
  const ascii = (start: number, end: number) => Buffer.from(bytes.subarray(start, end)).toString("ascii");
  if (type === "image/png") {
    return bytes.byteLength >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
  }
  if (type === "image/jpeg") return bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === "image/gif") return ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a";
  if (type === "image/webp") return bytes.byteLength >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
  if (type === "image/bmp") return bytes.byteLength >= 2 && ascii(0, 2) === "BM";
  if (type === "image/avif") {
    return bytes.byteLength >= 12
      && ascii(4, 8) === "ftyp"
      && ["avif", "avis"].includes(ascii(8, 12));
  }
  return false;
}

function normalizePreferences(preferences: { strength: number; fit: BackgroundFit }): {
  strength: number;
  fit: BackgroundFit;
} {
  return {
    strength: Math.min(MAX_BACKGROUND_STRENGTH, Math.max(MIN_BACKGROUND_STRENGTH, preferences.strength)),
    fit: preferences.fit,
  };
}

function parseStoredBackgroundMetadata(value: unknown): StoredBackgroundMetadata | null {
  if (typeof value !== "object" || value === null) return null;
  const metadata = value as Partial<StoredBackgroundMetadata>;
  if (
    typeof metadata.name !== "string"
    || !metadata.name.trim()
    || typeof metadata.type !== "string"
    || !SUPPORTED_IMAGE_TYPES.has(metadata.type)
    || typeof metadata.size !== "number"
    || !Number.isSafeInteger(metadata.size)
    || metadata.size < 0
    || metadata.size > MAX_BACKGROUND_FILE_BYTES
    || typeof metadata.updatedAt !== "number"
    || !Number.isFinite(metadata.updatedAt)
  ) return null;

  const preferences = normalizePreferences({
    strength: typeof metadata.strength === "number" && Number.isFinite(metadata.strength)
      ? metadata.strength
      : DEFAULT_BACKGROUND_PREFERENCES.strength,
    fit: metadata.fit === "contain" || metadata.fit === "cover"
      ? metadata.fit
      : DEFAULT_BACKGROUND_PREFERENCES.fit,
  });
  return { ...metadata, ...preferences } as StoredBackgroundMetadata;
}

function serializeStoredBackground(bytes: Uint8Array, metadata: StoredBackgroundMetadata): Buffer {
  const metadataBytes = Buffer.from(JSON.stringify(metadata), "utf8");
  if (metadataBytes.byteLength > MAX_METADATA_BYTES) {
    throw new InvalidBackgroundError("Image name is too long");
  }
  const container = Buffer.allocUnsafe(
    CONTAINER_MAGIC.byteLength + METADATA_LENGTH_BYTES + metadataBytes.byteLength + bytes.byteLength,
  );
  CONTAINER_MAGIC.copy(container, 0);
  container.writeUInt32BE(metadataBytes.byteLength, CONTAINER_MAGIC.byteLength);
  metadataBytes.copy(container, CONTAINER_MAGIC.byteLength + METADATA_LENGTH_BYTES);
  container.set(bytes, CONTAINER_MAGIC.byteLength + METADATA_LENGTH_BYTES + metadataBytes.byteLength);
  return container;
}

function parseStoredBackground(container: Buffer): StoredBackground | null {
  const headerBytes = CONTAINER_MAGIC.byteLength + METADATA_LENGTH_BYTES;
  if (container.byteLength < headerBytes || !container.subarray(0, CONTAINER_MAGIC.byteLength).equals(CONTAINER_MAGIC)) {
    return null;
  }
  const metadataLength = container.readUInt32BE(CONTAINER_MAGIC.byteLength);
  if (metadataLength > MAX_METADATA_BYTES || headerBytes + metadataLength > container.byteLength) return null;

  try {
    const metadata = parseStoredBackgroundMetadata(JSON.parse(
      container.subarray(headerBytes, headerBytes + metadataLength).toString("utf8"),
    ));
    if (!metadata) return null;
    const bytes = container.subarray(headerBytes + metadataLength);
    if (bytes.byteLength !== metadata.size) return null;
    return { bytes, metadata };
  } catch {
    return null;
  }
}

export function readStoredBackground(agentDir = getAgentDir()): StoredBackground | null {
  const path = getBackgroundPath(agentDir);
  if (!existsSync(path)) return null;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_BACKGROUND_FILE_BYTES + MAX_METADATA_BYTES + 64) return null;
    return parseStoredBackground(readFileSync(path));
  } catch {
    return null;
  }
}

export function writeStoredBackground(
  bytes: Uint8Array,
  name: string,
  type: string,
  preferences: { strength: number; fit: BackgroundFit },
  agentDir = getAgentDir(),
): StoredBackgroundMetadata {
  if (!SUPPORTED_IMAGE_TYPES.has(type)) throw new InvalidBackgroundError("Unsupported image type");
  if (!name.trim()) throw new InvalidBackgroundError("Image name is required");
  if (bytes.byteLength > MAX_BACKGROUND_FILE_BYTES) {
    throw new BackgroundTooLargeError("Background image is too large");
  }
  if (!matchesImageType(bytes, type)) throw new InvalidBackgroundError("Image content does not match its type");

  const directory = getPersonalizationDirectory(agentDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);

  const metadata: StoredBackgroundMetadata = {
    name,
    type,
    size: bytes.byteLength,
    updatedAt: Date.now(),
    ...normalizePreferences(preferences),
  };
  writePrivateBufferAtomicSync(getBackgroundPath(agentDir), serializeStoredBackground(bytes, metadata));
  return metadata;
}

export function updateStoredBackgroundPreferences(
  preferences: { strength: number; fit: BackgroundFit },
  agentDir = getAgentDir(),
): StoredBackgroundMetadata | null {
  const stored = readStoredBackground(agentDir);
  if (!stored) return null;
  const metadata: StoredBackgroundMetadata = {
    ...stored.metadata,
    ...normalizePreferences(preferences),
  };
  writePrivateBufferAtomicSync(
    getBackgroundPath(agentDir),
    serializeStoredBackground(stored.bytes, metadata),
  );
  return metadata;
}

export function deleteStoredBackground(agentDir = getAgentDir()): void {
  rmSync(getBackgroundPath(agentDir), { force: true });
  rmSync(join(getPersonalizationDirectory(agentDir), LEGACY_BACKGROUND_METADATA_FILE), { force: true });
}
