// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "RouteHelper",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "RouteHelper",
            path: "Sources/RouteHelper"
        )
    ]
)
