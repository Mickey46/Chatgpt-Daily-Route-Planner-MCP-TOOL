import Foundation
import CoreLocation
import MapKit
import EventKit

// RouteHelper: a small CLI bridge so the Electron/Node backend can use
// MapKit (geocoding + drive-time directions, no API key needed) and
// EventKit (Apple Calendar sync) without embedding native bindings in Node.
//
// Protocol: a single JSON object on stdin, e.g. {"action":"geocode","payload":{"address":"..."}}
// A single JSON object is written to stdout, then the process exits.
// On failure: {"error": "message"}.

enum HelperError: Error, CustomStringConvertible {
    case badInput(String)
    case notFound(String)
    var description: String {
        switch self {
        case .badInput(let m): return m
        case .notFound(let m): return m
        }
    }
}

func readStdin() throws -> [String: Any] {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw HelperError.badInput("stdin was not a JSON object")
    }
    return obj
}

func writeOutput(_ obj: [String: Any]) {
    let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
}

func writeError(_ message: String) {
    writeOutput(["error": message])
}

// MARK: - MapKit: geocode + directions

func geocode(address: String) async throws -> [String: Any] {
    let geocoder = CLGeocoder()
    let placemarks = try await geocoder.geocodeAddressString(address)
    guard let coord = placemarks.first?.location?.coordinate else {
        throw HelperError.notFound("no coordinates found for address")
    }
    return ["lat": coord.latitude, "lng": coord.longitude]
}

func directions(fromLat: Double, fromLng: Double, toLat: Double, toLng: Double) async throws -> [String: Any] {
    let source = MKMapItem(placemark: MKPlacemark(coordinate: CLLocationCoordinate2D(latitude: fromLat, longitude: fromLng)))
    let dest = MKMapItem(placemark: MKPlacemark(coordinate: CLLocationCoordinate2D(latitude: toLat, longitude: toLng)))

    let request = MKDirections.Request()
    request.source = source
    request.destination = dest
    request.transportType = .automobile

    let directions = MKDirections(request: request)
    let response = try await directions.calculate()
    guard let route = response.routes.first else {
        throw HelperError.notFound("no route found")
    }
    return ["minutes": route.expectedTravelTime / 60.0, "miles": route.distance / 1609.344]
}

// MARK: - EventKit: calendar sync

let scheduleCalendarName = "BCBA Schedule"

func getOrCreateCalendar(_ store: EKEventStore) throws -> EKCalendar {
    if let existing = store.calendars(for: .event).first(where: { $0.title == scheduleCalendarName }) {
        return existing
    }
    let calendar = EKCalendar(for: .event, eventStore: store)
    calendar.title = scheduleCalendarName
    guard let source = store.defaultCalendarForNewEvents?.source ?? store.sources.first(where: { $0.sourceType == .local }) ?? store.sources.first else {
        throw HelperError.notFound("no writable calendar source available")
    }
    calendar.source = source
    try store.saveCalendar(calendar, commit: true)
    return calendar
}

func requestCalendarAccess(_ store: EKEventStore) async throws -> Bool {
    if #available(macOS 14.0, *) {
        return try await store.requestFullAccessToEvents()
    } else {
        return try await withCheckedThrowingContinuation { cont in
            store.requestAccess(to: .event) { granted, error in
                if let error = error { cont.resume(throwing: error) } else { cont.resume(returning: granted) }
            }
        }
    }
}

let isoFormatter = ISO8601DateFormatter()

func createEvent(store: EKEventStore, title: String, notes: String?, startISO: String, endISO: String, location: String?) throws -> String {
    guard let start = isoFormatter.date(from: startISO), let end = isoFormatter.date(from: endISO) else {
        throw HelperError.badInput("startISO/endISO must be ISO8601")
    }
    let event = EKEvent(eventStore: store)
    event.title = title
    event.notes = notes
    event.startDate = start
    event.endDate = end
    event.location = location
    event.calendar = try getOrCreateCalendar(store)
    try store.save(event, span: .thisEvent)
    return event.eventIdentifier
}

func updateEvent(store: EKEventStore, eventId: String, title: String?, notes: String?, startISO: String?, endISO: String?, location: String?) throws {
    guard let event = store.event(withIdentifier: eventId) else {
        throw HelperError.notFound("event not found: \(eventId)")
    }
    if let title = title { event.title = title }
    if let notes = notes { event.notes = notes }
    if let location = location { event.location = location }
    if let startISO = startISO, let start = isoFormatter.date(from: startISO) { event.startDate = start }
    if let endISO = endISO, let end = isoFormatter.date(from: endISO) { event.endDate = end }
    try store.save(event, span: .thisEvent)
}

func deleteEvent(store: EKEventStore, eventId: String) throws {
    guard let event = store.event(withIdentifier: eventId) else {
        // already gone; treat as success
        return
    }
    try store.remove(event, span: .thisEvent)
}

// MARK: - Dispatch

func run() async {
    let input: [String: Any]
    do {
        input = try readStdin()
    } catch {
        writeError("\(error)")
        return
    }

    guard let action = input["action"] as? String else {
        writeError("missing 'action'")
        return
    }
    let payload = input["payload"] as? [String: Any] ?? [:]

    do {
        switch action {
        case "geocode":
            guard let address = payload["address"] as? String else { throw HelperError.badInput("payload.address required") }
            writeOutput(try await geocode(address: address))

        case "directions":
            guard let fromLat = payload["fromLat"] as? Double, let fromLng = payload["fromLng"] as? Double,
                  let toLat = payload["toLat"] as? Double, let toLng = payload["toLng"] as? Double else {
                throw HelperError.badInput("payload.fromLat/fromLng/toLat/toLng required")
            }
            writeOutput(try await directions(fromLat: fromLat, fromLng: fromLng, toLat: toLat, toLng: toLng))

        case "calendarRequestAccess":
            let store = EKEventStore()
            let granted = try await requestCalendarAccess(store)
            writeOutput(["granted": granted])

        case "calendarCreateEvent":
            guard let title = payload["title"] as? String, let startISO = payload["startISO"] as? String, let endISO = payload["endISO"] as? String else {
                throw HelperError.badInput("payload.title/startISO/endISO required")
            }
            let store = EKEventStore()
            _ = try await requestCalendarAccess(store)
            let eventId = try createEvent(store: store, title: title, notes: payload["notes"] as? String, startISO: startISO, endISO: endISO, location: payload["location"] as? String)
            writeOutput(["eventId": eventId])

        case "calendarUpdateEvent":
            guard let eventId = payload["eventId"] as? String else { throw HelperError.badInput("payload.eventId required") }
            let store = EKEventStore()
            _ = try await requestCalendarAccess(store)
            try updateEvent(store: store, eventId: eventId, title: payload["title"] as? String, notes: payload["notes"] as? String, startISO: payload["startISO"] as? String, endISO: payload["endISO"] as? String, location: payload["location"] as? String)
            writeOutput(["ok": true])

        case "calendarDeleteEvent":
            guard let eventId = payload["eventId"] as? String else { throw HelperError.badInput("payload.eventId required") }
            let store = EKEventStore()
            _ = try await requestCalendarAccess(store)
            try deleteEvent(store: store, eventId: eventId)
            writeOutput(["ok": true])

        default:
            throw HelperError.badInput("unknown action: \(action)")
        }
    } catch {
        writeError("\(error)")
    }
}

// main.swift gets an implicit async top-level context (Swift 5.5+), so we
// can just `await` directly here -- no need to block the main thread with a
// semaphore, which would deadlock against completions (e.g. CLGeocoder,
// MKDirections) that resume on the main queue.
await run()
