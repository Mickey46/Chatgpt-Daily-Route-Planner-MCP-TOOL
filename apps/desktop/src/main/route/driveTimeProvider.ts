import { AppDatabase, Client } from "../db";
import * as routeHelper from "../native/routeHelper";
import type { Location } from "./optimizer";

// Resolves a client's address to lat/lng (geocoding + caching on the client
// row) and wraps RouteHelper's `directions` call.

export async function ensureClientGeocoded(db: AppDatabase, client: Client): Promise<Location> {
  if (client.lat != null && client.lng != null) {
    return { lat: client.lat, lng: client.lng };
  }
  const { lat, lng } = await routeHelper.geocode(client.address);
  db.updateClient(client.id, { lat, lng });
  return { lat, lng };
}

export async function geocodeAddress(address: string): Promise<Location> {
  return routeHelper.geocode(address);
}

export async function getDriveTime(from: Location, to: Location): Promise<{ minutes: number; miles: number }> {
  return routeHelper.directions(from, to);
}
