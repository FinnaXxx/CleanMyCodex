// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CleanMyCodex",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "CleanMyCodex", targets: ["CleanMyCodex"])
    ],
    targets: [
        .executableTarget(name: "CleanMyCodex"),
        .testTarget(name: "CleanMyCodexTests", dependencies: ["CleanMyCodex"])
    ]
)
