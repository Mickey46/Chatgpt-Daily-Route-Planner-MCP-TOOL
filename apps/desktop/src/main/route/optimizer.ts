// Day-schedule optimizer: orders a day's sessions to minimize drive time,
// treating any time_fixed sessions as anchors that can't move.
//
// This is intentionally a heuristic (cheapest-insertion + forward time-walk),
// not a full vehicle-routing/time-window solver -- a BCBA's day is a handful
// of stops (typically <=10), so a real TSP solver would be overkill.

export interface Location {
  lat: number;
  lng: number;
}

export interface OptimizerStop {
  session_id: string;
  location: Location;
  duration_min: number;
  time_fixed: boolean;
  /** "HH:MM" 24h, required when time_fixed is true */
  start_time: string | null;
}

export interface DriveTime {
  minutes: number;
  miles: number;
}

export type DriveTimeFn = (from: Location, to: Location) => Promise<DriveTime>;

export interface DayPlanEntry {
  session_id: string;
  start_time: string; // HH:MM
  end_time: string; // HH:MM
  time_fixed: boolean;
}

export interface DayPlanSegment {
  from_session_id: string;
  to_session_id: string;
  minutes: number;
  miles: number;
}

export interface DayPlan {
  order: DayPlanEntry[];
  segments: DayPlanSegment[];
  total_drive_minutes: number;
  warnings: string[];
}

export interface OptimizerOptions {
  bufferMinutes: number; // minimum buffer inserted between every pair of stops
  dayStartMinutes?: number; // default 8:00am, used to seed the first flexible stop if there are no anchors
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function minutesToTime(mins: number): string {
  const wrapped = ((Math.round(mins) % (24 * 60)) + 24 * 60) % (24 * 60);
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Orders stops via cheapest-insertion: anchors (fixed-time stops, sorted by
 * start_time) form the initial route skeleton; each flexible stop is
 * inserted at whichever position adds the least drive distance.
 */
function orderStops(stops: OptimizerStop[], driveCost: Map<string, number>): OptimizerStop[] {
  const anchors = stops
    .filter((s) => s.time_fixed && s.start_time)
    .sort((a, b) => timeToMinutes(a.start_time!) - timeToMinutes(b.start_time!));
  const flexible = stops.filter((s) => !(s.time_fixed && s.start_time));

  let route: OptimizerStop[] = anchors.length > 0 ? [...anchors] : flexible.length > 0 ? [flexible[0]] : [];
  const remaining = anchors.length > 0 ? [...flexible] : flexible.slice(1);

  const costKey = (a: OptimizerStop, b: OptimizerStop) => `${a.session_id}->${b.session_id}`;
  const costOf = (a: OptimizerStop, b: OptimizerStop) => driveCost.get(costKey(a, b)) ?? 0;

  for (const stop of remaining) {
    if (route.length === 0) {
      route = [stop];
      continue;
    }
    if (route.length === 1) {
      route.push(stop);
      continue;
    }
    let bestIndex = route.length; // default: append at end
    let bestDelta = Infinity;
    for (let i = 0; i <= route.length; i++) {
      const prev = route[i - 1];
      const next = route[i];
      let delta: number;
      if (!prev) {
        delta = costOf(stop, next);
      } else if (!next) {
        delta = costOf(prev, stop);
      } else {
        delta = costOf(prev, stop) + costOf(stop, next) - costOf(prev, next);
      }
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIndex = i;
      }
    }
    route.splice(bestIndex, 0, stop);
  }

  return route;
}

export async function optimizeDay(
  stops: OptimizerStop[],
  driveTimeFn: DriveTimeFn,
  options: OptimizerOptions
): Promise<DayPlan> {
  if (stops.length === 0) {
    return { order: [], segments: [], total_drive_minutes: 0, warnings: [] };
  }
  if (stops.length === 1) {
    const s = stops[0];
    const start = s.time_fixed && s.start_time ? s.start_time : minutesToTime(options.dayStartMinutes ?? 8 * 60);
    return {
      order: [{ session_id: s.session_id, start_time: start, end_time: minutesToTime(timeToMinutes(start) + s.duration_min), time_fixed: s.time_fixed }],
      segments: [],
      total_drive_minutes: 0,
      warnings: [],
    };
  }

  // Precompute pairwise drive costs (small N, so O(n^2) is fine).
  const driveCost = new Map<string, number>();
  const driveTimeCache = new Map<string, DriveTime>();
  const pairKey = (a: OptimizerStop, b: OptimizerStop) => `${a.session_id}->${b.session_id}`;

  for (const a of stops) {
    for (const b of stops) {
      if (a.session_id === b.session_id) continue;
      const dt = await driveTimeFn(a.location, b.location);
      driveTimeCache.set(pairKey(a, b), dt);
      driveCost.set(pairKey(a, b), dt.minutes);
    }
  }

  const route = orderStops(stops, driveCost);

  // Walk forward in time, respecting fixed anchors, flagging conflicts.
  const warnings: string[] = [];
  const order: DayPlanEntry[] = [];
  const segments: DayPlanSegment[] = [];
  let totalDrive = 0;
  let cursor: number | null = null;

  for (let i = 0; i < route.length; i++) {
    const stop = route[i];
    let start: number;
    if (stop.time_fixed && stop.start_time) {
      start = timeToMinutes(stop.start_time);
      if (cursor !== null && start < cursor) {
        warnings.push(
          `${stop.session_id} is fixed at ${stop.start_time} but the previous stop doesn't finish (with drive + buffer) until ${minutesToTime(cursor)}`
        );
      }
    } else {
      start = cursor ?? options.dayStartMinutes ?? 8 * 60;
    }

    if (i > 0) {
      const prev = route[i - 1];
      const dt = driveTimeCache.get(pairKey(prev, stop))!;
      segments.push({ from_session_id: prev.session_id, to_session_id: stop.session_id, minutes: dt.minutes, miles: dt.miles });
      totalDrive += dt.minutes;
    }

    const end = start + stop.duration_min;
    order.push({ session_id: stop.session_id, start_time: minutesToTime(start), end_time: minutesToTime(end), time_fixed: stop.time_fixed });

    const next = route[i + 1];
    if (next) {
      const dt = driveTimeCache.get(pairKey(stop, next))!;
      cursor = end + dt.minutes + options.bufferMinutes;
    }
  }

  return { order, segments, total_drive_minutes: Math.round(totalDrive), warnings };
}
