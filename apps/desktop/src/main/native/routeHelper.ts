import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

// Bridges to the compiled Swift RouteHelper CLI (native/RouteHelper), which
// wraps MapKit (geocode/directions -- no API key needed) and EventKit
// (Apple Calendar sync). See native/RouteHelper/Sources/RouteHelper/main.swift
// for the JSON stdin/stdout protocol this module speaks.

function resolveHelperPath(): string {
  // Packaged app: binary is copied into Resources/RouteHelper (see electron-builder.yml extraResources).
  const packaged = path.join(process.resourcesPath ?? "", "RouteHelper");
  if (fs.existsSync(packaged)) return packaged;
  // Dev: use the swift build output directly.
  const dev = path.join(__dirname, "..", "..", "..", "native", "RouteHelper", ".build", "release", "RouteHelper");
  if (fs.existsSync(dev)) return dev;
  const devDebug = path.join(__dirname, "..", "..", "..", "native", "RouteHelper", ".build", "debug", "RouteHelper");
  if (fs.existsSync(devDebug)) return devDebug;
  throw new Error("RouteHelper binary not found. Run `npm run build:native` first.");
}

interface HelperResult {
  [key: string]: unknown;
  error?: string;
}

function callHelper(action: string, payload: Record<string, unknown> = {}): Promise<HelperResult> {
  return new Promise((resolve, reject) => {
    const bin = resolveHelperPath();
    const child = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (!stdout.trim()) {
        reject(new Error(`RouteHelper produced no output (exit ${code}). stderr: ${stderr}`));
        return;
      }
      try {
        const result = JSON.parse(stdout) as HelperResult;
        if (result.error) {
          reject(new Error(`RouteHelper error: ${result.error}`));
        } else {
          resolve(result);
        }
      } catch (e) {
        reject(new Error(`RouteHelper returned invalid JSON: ${stdout}`));
      }
    });
    child.stdin.write(JSON.stringify({ action, payload }));
    child.stdin.end();
  });
}

export async function geocode(address: string): Promise<{ lat: number; lng: number }> {
  const result = await callHelper("geocode", { address });
  return { lat: result.lat as number, lng: result.lng as number };
}

export async function directions(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number }
): Promise<{ minutes: number; miles: number }> {
  const result = await callHelper("directions", { fromLat: from.lat, fromLng: from.lng, toLat: to.lat, toLng: to.lng });
  return { minutes: result.minutes as number, miles: result.miles as number };
}

export async function calendarRequestAccess(): Promise<boolean> {
  const result = await callHelper("calendarRequestAccess");
  return Boolean(result.granted);
}

export async function calendarCreateEvent(input: {
  title: string;
  notes?: string;
  startISO: string;
  endISO: string;
  location?: string;
}): Promise<string> {
  const result = await callHelper("calendarCreateEvent", input);
  return result.eventId as string;
}

export async function calendarUpdateEvent(input: {
  eventId: string;
  title?: string;
  notes?: string;
  startISO?: string;
  endISO?: string;
  location?: string;
}): Promise<void> {
  await callHelper("calendarUpdateEvent", input);
}

export async function calendarDeleteEvent(eventId: string): Promise<void> {
  await callHelper("calendarDeleteEvent", { eventId });
}
