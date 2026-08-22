import Foundation
import Testing
@testable import CleanMyCodex

struct SessionSlimmerTests {
    /// Long enough that replacing it actually shrinks the file — the placeholder is ~120 bytes.
    private let payloadA = String(repeating: "QUJD", count: 1_000)
    private let payloadB = String(repeating: "RUZH", count: 1_000)

    private func line(_ payload: String, text: String = "step") -> String {
        #"{"type":"response_item","payload":{"text":"\#(text)","image_url":"data:image/png;base64,\#(payload)"}}"#
    }

    private func write(_ lines: [String], to fixture: TemporaryFixture) throws -> URL {
        let url = fixture.file("sessions/rollout.jsonl")
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data((lines.joined(separator: "\n") + "\n").utf8).write(to: url)
        return url
    }

    @Test func deduplicationKeepsTheFirstCopyAndReplacesRepeats() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let source = try write(
            [line(payloadA, text: "one"), line(payloadA, text: "two"), line(payloadB, text: "three")],
            to: fixture
        )
        let destination = fixture.file("out.jsonl")

        let result = try SessionSlimmer().rewrite(source, to: destination, mode: .deduplicate)

        #expect(result.replacedCount == 1)
        #expect(result.keptCount == 2)
        #expect(result.lineCount == 3)

        let output = try String(contentsOf: destination, encoding: .utf8)
        let outputLines = output.split(separator: "\n").map(String.init)
        #expect(outputLines.count == 3)
        #expect(outputLines[0] == line(payloadA, text: "one"))
        #expect(outputLines[1] == line(SessionSlimmer.placeholderPayload, text: "two"))
        #expect(outputLines[2] == line(payloadB, text: "three"))
        #expect(FileSize.of(destination) < FileSize.of(source))
    }

    @Test func stripAllReplacesEveryImage() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let source = try write([line(payloadA), line(payloadB)], to: fixture)
        let destination = fixture.file("out.jsonl")

        let result = try SessionSlimmer().rewrite(source, to: destination, mode: .stripAll)

        #expect(result.replacedCount == 2)
        #expect(result.keptCount == 0)
        let output = try String(contentsOf: destination, encoding: .utf8)
        #expect(!output.contains(payloadA))
        #expect(!output.contains(payloadB))
        #expect(output.contains(SessionSlimmer.placeholderPayload))
    }

    /// The rewrite must not depend on where read boundaries happen to land.
    @Test func chunkBoundariesDoNotChangeTheOutput() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let source = try write([line(payloadA), line(payloadA), line(payloadB)], to: fixture)

        var outputs: [Data] = []
        for chunkSize in [64, 97, 512, 4_096, 1_048_576] {
            let destination = fixture.file("out-\(chunkSize).jsonl")
            _ = try SessionSlimmer(chunkSize: chunkSize)
                .rewrite(source, to: destination, mode: .deduplicate)
            outputs.append(try Data(contentsOf: destination))
        }

        #expect(Set(outputs).count == 1)
        let text = try #require(String(data: outputs[0], encoding: .utf8))
        #expect(text.split(separator: "\n").count == 3)
    }

    @Test func everyOutputLineIsStillValidJSON() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let source = try write(
            [
                #"{"type":"session_meta","payload":{"id":"abc","cwd":"/tmp/demo"}}"#,
                line(payloadA),
                line(payloadA),
                #"{"type":"event_msg","payload":{"type":"user_message","message":"没有图片的一行"}}"#
            ],
            to: fixture
        )
        let destination = fixture.file("out.jsonl")

        _ = try SessionSlimmer(chunkSize: 128).rewrite(source, to: destination, mode: .deduplicate)

        let output = try String(contentsOf: destination, encoding: .utf8)
        for line in output.split(separator: "\n") {
            #expect((try? JSONSerialization.jsonObject(with: Data(line.utf8))) != nil)
        }
    }

    @Test func linesWithoutImagesAreCopiedByteForByte() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let plain = [
            #"{"a":1,"b":[1,2,3],"c":"含中文和 \"转义\" 的文本","d":1.50}"#,
            #"{"note":"这里提到 data:image 但不是 URI"}"#
        ]
        let source = try write(plain, to: fixture)
        let destination = fixture.file("out.jsonl")

        _ = try SessionSlimmer(chunkSize: 32).rewrite(source, to: destination, mode: .stripAll)

        let rewritten = try Data(contentsOf: destination)
        let original = try Data(contentsOf: source)
        #expect(rewritten == original)
    }

    @Test func escapedSlashesAreHandled() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let escaped = #"{"image_url":"data:image\/png;base64,\#(payloadA)"}"#
        let source = try write([escaped, escaped], to: fixture)
        let destination = fixture.file("out.jsonl")

        let result = try SessionSlimmer().rewrite(source, to: destination, mode: .deduplicate)

        #expect(result.replacedCount == 1)
        let output = try String(contentsOf: destination, encoding: .utf8)
        #expect(output.contains(escaped))
        #expect(output.contains(SessionSlimmer.placeholderPayload))
    }

    @Test func slimReplacesTheFileAndKeepsTheOriginalRecoverable() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let source = try write([line(payloadA), line(payloadA), line(payloadA)], to: fixture)
        let originalBytes = FileSize.of(source)
        let originalModified = try source.resourceValues(forKeys: [.contentModificationDateKey])
            .contentModificationDate

        let report = try SessionSlimmer().slim(source, mode: .deduplicate)

        #expect(report.replacedCount == 2)
        #expect(report.freedBytes > 0)
        #expect(FileSize.of(source) < originalBytes)
        #expect(report.trashedOriginal != nil)
        // The thread is still there, and its timestamp still means "last activity".
        let output = try String(contentsOf: source, encoding: .utf8)
        #expect(output.split(separator: "\n").count == 3)
        #expect(output.contains(payloadA))
        let modified = try source.resourceValues(forKeys: [.contentModificationDateKey])
            .contentModificationDate
        #expect(modified == originalModified)

        if let trashed = report.trashedOriginal {
            #expect(FileSize.of(trashed) == originalBytes)
            try? FileManager.default.removeItem(at: trashed)
        }
    }

    @Test func slimRefusesWhenThereIsNothingToReclaim() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let source = try write([line(payloadA), line(payloadB)], to: fixture)

        #expect(throws: SessionSlimError.self) {
            try SessionSlimmer().slim(source, mode: .deduplicate)
        }
        // Nothing was touched.
        let untouched = try String(contentsOf: source, encoding: .utf8)
        #expect(untouched.contains(payloadA))
    }

    @Test func scannerReportsDuplicatesSoTheUICanOfferSlimming() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.remove() }
        let id = "99999999-1111-2222-3333-444444444444"
        let body = [line(payloadA), line(payloadA), line(payloadA), line(payloadB)]
            .joined(separator: "\n") + "\n"
        let meta = "{\"type\":\"session_meta\",\"payload\":{\"id\":\"\(id)\"}}\n"
        try Data((meta + body).utf8)
            .write(to: fixture.directory("sessions").appending(path: "rollout-\(id).jsonl"))

        let sessions = try CodexStorageScanner(chunkSize: 97, libraryDirectory: fixture.directory("Library"))
            .scanSessions(in: fixture.root)
        let session = try #require(sessions.first)

        #expect(session.embeddedImageCount == 4)
        #expect(session.distinctImageCount == 2)
        #expect(session.duplicateImageBytes > 0)
        #expect(session.slimmableBytes == session.duplicateImageBytes)
        #expect(session.hasDuplicateImages)
    }
}
