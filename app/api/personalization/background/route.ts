import { NextResponse } from "next/server";
import {
  BackgroundTooLargeError,
  InvalidBackgroundError,
  deleteStoredBackground,
  readStoredBackground,
  updateStoredBackgroundPreferences,
  writeStoredBackground,
} from "@/lib/personalization-server-storage";
import {
  MAX_BACKGROUND_FILE_BYTES,
  type BackgroundFit,
} from "@/lib/personalization";
import { isApiRequestAllowed } from "@/lib/request-security";

export const runtime = "nodejs";

const MAX_REQUEST_BYTES = MAX_BACKGROUND_FILE_BYTES + 1024;

function denied(): NextResponse {
  return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
}

async function readBodyWithinLimit(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    throw new BackgroundTooLargeError("Background image is too large");
  }

  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new BackgroundTooLargeError("Background image is too large");
      }
      size += value.byteLength;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function parseFit(value: string | null): BackgroundFit | null {
  return value === "cover" || value === "contain" ? value : null;
}

function metadataHeaders(stored: NonNullable<ReturnType<typeof readStoredBackground>>): HeadersInit {
  return {
    "Cache-Control": "private, no-store, max-age=0",
    "Content-Type": stored.metadata.type,
    "Content-Length": String(stored.metadata.size),
    "X-Content-Type-Options": "nosniff",
    "X-Pi-Background-Name": encodeURIComponent(stored.metadata.name),
    "X-Pi-Background-Strength": String(stored.metadata.strength),
    "X-Pi-Background-Fit": stored.metadata.fit,
  };
}

export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return denied();
  const stored = readStoredBackground();
  if (!stored) {
    return NextResponse.json(
      { error: "Background image not found" },
      { status: 404, headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  }
  return new Response(new Uint8Array(stored.bytes), { headers: metadataHeaders(stored) });
}

export async function PUT(request: Request) {
  if (!isApiRequestAllowed(request)) return denied();
  try {
    const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    const encodedName = request.headers.get("x-pi-background-name");
    const name = encodedName ? decodeURIComponent(encodedName) : "background";
    const strength = Number(request.headers.get("x-pi-background-strength"));
    const fit = parseFit(request.headers.get("x-pi-background-fit"));
    if (!Number.isFinite(strength) || !fit) {
      return NextResponse.json({ error: "Invalid background preferences" }, { status: 400 });
    }

    const bytes = await readBodyWithinLimit(request, MAX_REQUEST_BYTES);
    const metadata = writeStoredBackground(bytes, name, type, { strength, fit });
    return NextResponse.json({ metadata });
  } catch (error) {
    if (error instanceof BackgroundTooLargeError) {
      return NextResponse.json({ error: error.message }, { status: 413 });
    }
    if (error instanceof InvalidBackgroundError || error instanceof URIError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  if (!isApiRequestAllowed(request)) return denied();
  try {
    const body = await request.json() as { strength?: unknown; fit?: unknown };
    const strength = body.strength;
    const fit = parseFit(typeof body.fit === "string" ? body.fit : null);
    if (typeof strength !== "number" || !Number.isFinite(strength) || !fit) {
      return NextResponse.json({ error: "Invalid background preferences" }, { status: 400 });
    }
    const metadata = updateStoredBackgroundPreferences({ strength, fit });
    if (!metadata) return NextResponse.json({ error: "Background image not found" }, { status: 404 });
    return NextResponse.json({ metadata });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  if (!isApiRequestAllowed(request)) return denied();
  try {
    deleteStoredBackground();
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
