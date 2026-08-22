import CryptoKit
import Foundation

/// How much of a rollout's image payload to give up.
enum SessionSlimMode: String, CaseIterable, Identifiable, Sendable {
    /// Keep the first copy of every distinct picture, replace the repeats.
    case deduplicate
    /// Replace every embedded picture.
    case stripAll

    var id: String { rawValue }

    var label: String {
        switch self {
        case .deduplicate: "只去重（保留每张图的第一份）"
        case .stripAll: "剥离全部内嵌图片"
        }
    }

    var detail: String {
        switch self {
        case .deduplicate:
            "同一张截图在多轮里被反复写回文件，这里只保留第一份，后面的重复替换成 1×1 占位图。"
                + "每张图都还在文件里，恢复会话时最早出现的位置仍能看到。"
        case .stripAll:
            "所有内嵌图片都替换成 1×1 占位图。省得最多，但这个会话里的截图从此看不到了。"
        }
    }
}

struct SessionSlimReport: Sendable {
    let url: URL
    let originalBytes: Int64
    let newBytes: Int64
    let replacedCount: Int
    let keptCount: Int
    let trashedOriginal: URL?

    var freedBytes: Int64 { max(0, originalBytes - newBytes) }
}

enum SessionSlimError: LocalizedError {
    case compressed(String)
    case changedWhileWorking(String)
    case verificationFailed(String)
    case nothingToDo(String)

    var errorDescription: String? {
        switch self {
        case let .compressed(name): "\(name) 是压缩会话，暂不支持瘦身"
        case let .changedWhileWorking(name): "\(name) 在处理过程中被写入，已放弃"
        case let .verificationFailed(reason): "校验没通过，原文件保持不变：\(reason)"
        case let .nothingToDo(name): "\(name) 里没有可以回收的内嵌图片"
        }
    }
}

/// Rewrites a rollout file so repeated screenshots stop costing hundreds of megabytes.
///
/// This is the one operation that edits Codex' own data, so it is deliberately narrow:
/// only the bytes between `data:image/…` and the closing quote of that JSON string are
/// touched, and they are replaced by a valid 1×1 PNG data URI. Everything else — every
/// other byte on every line, key order, spacing, escaping — is copied through untouched,
/// so a line that was valid JSON before is still valid JSON after. The original goes to
/// the Trash, never straight to delete.
struct SessionSlimmer: Sendable {
    /// A real, valid, 1×1 transparent PNG. Anything reading the field still gets an image
    /// rather than a malformed URI.
    static let placeholderPayload =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    static let placeholder = "data:image/png;base64,\(placeholderPayload)"

    let chunkSize: Int
    /// A single data URI larger than this is passed through rather than buffered.
    let maximumURIBytes: Int
    /// Lines up to this size are re-parsed as JSON to prove the rewrite kept them valid.
    let verifyLineLimit: Int

    init(chunkSize: Int = 1_048_576, maximumURIBytes: Int = 96 * 1_048_576, verifyLineLimit: Int = 1_048_576) {
        self.chunkSize = max(64, chunkSize)
        self.maximumURIBytes = max(1_024, maximumURIBytes)
        self.verifyLineLimit = verifyLineLimit
    }

    // MARK: - Whole-file operation

    /// Rewrites `url` in place, leaving the previous version in the Trash.
    func slim(_ url: URL, mode: SessionSlimMode, manager: FileManager = FileManager()) throws -> SessionSlimReport {
        guard !url.lastPathComponent.hasSuffix(".zst") else {
            throw SessionSlimError.compressed(url.lastPathComponent)
        }
        let before = try url.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
        let originalBytes = FileSize.of(url)

        let workingURL = url.deletingLastPathComponent()
            .appending(path: ".cleanmycodex-\(UUID().uuidString).jsonl")
        var cleanupWorking = true
        defer { if cleanupWorking { try? manager.removeItem(at: workingURL) } }

        let rewrite = try rewrite(url, to: workingURL, mode: mode, manager: manager)
        guard rewrite.replacedCount > 0 else {
            throw SessionSlimError.nothingToDo(url.lastPathComponent)
        }

        // Nothing may have appended to the rollout while we were reading it.
        let after = try url.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
        guard after.contentModificationDate == before.contentModificationDate,
              after.fileSize == before.fileSize
        else { throw SessionSlimError.changedWhileWorking(url.lastPathComponent) }

        try verify(original: url, rewritten: workingURL, expectedLines: rewrite.lineCount)

        var trashed: NSURL?
        try manager.trashItem(at: url, resultingItemURL: &trashed)
        do {
            try manager.moveItem(at: workingURL, to: url)
        } catch {
            // The previous version is in the Trash and the new one is still on disk;
            // surface both rather than pretending the file vanished.
            throw SessionSlimError.verificationFailed(
                "新文件写好了但替换失败：\(workingURL.path)（原文件在废纸篓）"
            )
        }
        cleanupWorking = false

        if let modified = before.contentModificationDate {
            try? manager.setAttributes([.modificationDate: modified], ofItemAtPath: url.path)
        }

        return SessionSlimReport(
            url: url,
            originalBytes: originalBytes,
            newBytes: FileSize.of(url),
            replacedCount: rewrite.replacedCount,
            keptCount: rewrite.keptCount,
            trashedOriginal: trashed as URL?
        )
    }

    // MARK: - Streaming rewrite

    struct RewriteResult: Sendable {
        var replacedCount = 0
        var keptCount = 0
        var lineCount = 0
    }

    func rewrite(
        _ source: URL,
        to destination: URL,
        mode: SessionSlimMode,
        manager: FileManager = FileManager()
    ) throws -> RewriteResult {
        guard manager.createFile(atPath: destination.path, contents: nil) else {
            throw SessionSlimError.verificationFailed("无法创建临时文件 \(destination.path)")
        }
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        let output = try FileHandle(forWritingTo: destination)
        defer { try? output.close() }

        var rewriter = Rewriter(
            mode: mode,
            maximumURIBytes: maximumURIBytes,
            write: { try output.write(contentsOf: $0) }
        )
        while let chunk = try input.read(upToCount: chunkSize), !chunk.isEmpty {
            try rewriter.consume(chunk)
        }
        try rewriter.finish()
        try output.synchronize()
        return rewriter.result
    }

    // MARK: - Verification

    private func verify(original: URL, rewritten: URL, expectedLines: Int) throws {
        let originalLines = try countLines(original)
        let newLines = try countLines(rewritten)
        guard originalLines == newLines, newLines == expectedLines else {
            throw SessionSlimError.verificationFailed("行数不一致（\(originalLines) → \(newLines)）")
        }
        guard FileSize.of(rewritten) > 0 else {
            throw SessionSlimError.verificationFailed("新文件是空的")
        }
        try verifyJSONLines(rewritten)
    }

    private func countLines(_ url: URL) throws -> Int {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var count = 0
        while let chunk = try handle.read(upToCount: chunkSize), !chunk.isEmpty {
            for byte in chunk where byte == 0x0A { count += 1 }
        }
        return count
    }

    /// Re-parses the lines small enough to hold in memory. The oversized ones are the
    /// image-carrying lines, and those only ever changed inside a JSON string value.
    private func verifyJSONLines(_ url: URL) throws {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }

        var buffer = Data()
        var line = 0
        var oversized = false

        func check(_ data: Data) throws {
            line += 1
            guard !data.isEmpty else { return }
            guard data.count <= verifyLineLimit else { return }
            guard (try? JSONSerialization.jsonObject(with: data)) != nil else {
                throw SessionSlimError.verificationFailed("第 \(line) 行不是合法 JSON")
            }
        }

        while let chunk = try handle.read(upToCount: chunkSize), !chunk.isEmpty {
            var slice = chunk[...]
            while let newline = slice.firstIndex(of: 0x0A) {
                if !oversized {
                    buffer.append(contentsOf: slice[slice.startIndex..<newline])
                    try check(buffer)
                } else {
                    line += 1
                }
                buffer.removeAll(keepingCapacity: true)
                oversized = false
                slice = slice[slice.index(after: newline)...]
            }
            if !oversized {
                buffer.append(contentsOf: slice)
                if buffer.count > verifyLineLimit {
                    buffer.removeAll(keepingCapacity: false)
                    oversized = true
                }
            }
        }
        if !buffer.isEmpty { try check(buffer) }
    }
}

/// The state machine that copies a rollout through, swapping image payloads as it goes.
private struct Rewriter {
    private static let plainPrefix = Data("data:image/".utf8)
    private static let escapedSlashPrefix = Data(#"data:image\/"#.utf8)
    private static let carryLength = max(plainPrefix.count, escapedSlashPrefix.count) - 1

    let mode: SessionSlimMode
    let maximumURIBytes: Int
    let write: (Data) throws -> Void

    private(set) var result = SessionSlimmer.RewriteResult()
    private var carry = Data()
    private var buffer: Data?
    private var seen: Set<Data> = []

    init(mode: SessionSlimMode, maximumURIBytes: Int, write: @escaping (Data) throws -> Void) {
        self.mode = mode
        self.maximumURIBytes = maximumURIBytes
        self.write = write
    }

    mutating func consume(_ chunk: Data) throws {
        var data = Data()
        data.reserveCapacity(carry.count + chunk.count)
        data.append(carry)
        data.append(chunk)
        carry.removeAll(keepingCapacity: true)

        // Every input byte belongs to exactly one chunk, and carry is a prefix of the
        // previous chunk, so counting here counts each newline once.
        result.lineCount += chunk.reduce(0) { $1 == 0x0A ? $0 + 1 : $0 }

        var cursor = data.startIndex
        var passthrough = data.startIndex

        while cursor < data.endIndex {
            if buffer != nil {
                if let quote = data[cursor...].firstIndex(of: 0x22) {
                    try append(data[cursor..<quote])
                    try emitBuffer()
                    cursor = quote
                    passthrough = quote
                } else {
                    try append(data[cursor...])
                    cursor = data.endIndex
                    passthrough = data.endIndex
                }
                continue
            }

            guard let match = earliestPrefix(in: data, from: cursor) else {
                let remaining = data.distance(from: cursor, to: data.endIndex)
                let preserved = min(Self.carryLength, remaining)
                let end = data.index(data.endIndex, offsetBy: -preserved)
                try write(Data(data[passthrough..<end]))
                carry = Data(data[end...])
                return
            }

            try write(Data(data[passthrough..<match.lowerBound]))
            buffer = Data()
            cursor = match.lowerBound
            passthrough = match.lowerBound
        }

        if buffer == nil, passthrough < data.endIndex {
            try write(Data(data[passthrough...]))
        }
    }

    mutating func finish() throws {
        if buffer != nil {
            // The file ended inside a data URI; write it back exactly as it was.
            try flushBufferVerbatim()
        }
        if !carry.isEmpty {
            try write(carry)
            carry.removeAll()
        }
    }

    /// A data URI too large to hold is written straight through and stops being a
    /// candidate; correctness never depends on the buffer fitting.
    private mutating func append(_ bytes: Data.SubSequence) throws {
        guard var current = buffer else {
            try write(Data(bytes))
            return
        }
        if current.count + bytes.count > maximumURIBytes {
            buffer = nil
            result.keptCount += 1
            try write(current)
            try write(Data(bytes))
            return
        }
        current.append(contentsOf: bytes)
        buffer = current
    }

    private mutating func emitBuffer() throws {
        guard let uri = buffer else { return }
        buffer = nil

        var candidate = ImageCandidate()
        candidate.append(uri)
        guard candidate.isBase64Image else {
            try write(uri)
            return
        }

        let keep: Bool
        switch mode {
        case .stripAll:
            keep = false
        case .deduplicate:
            keep = seen.insert(candidate.payloadDigest()).inserted
        }

        if keep {
            result.keptCount += 1
            try write(uri)
        } else {
            result.replacedCount += 1
            try write(Data(SessionSlimmer.placeholder.utf8))
        }
    }

    private mutating func flushBufferVerbatim() throws {
        guard let uri = buffer else { return }
        buffer = nil
        result.keptCount += 1
        try write(uri)
    }

    private func earliestPrefix(in data: Data, from cursor: Data.Index) -> Range<Data.Index>? {
        let searchRange = cursor..<data.endIndex
        let plain = data.range(of: Self.plainPrefix, in: searchRange)
        let escaped = data.range(of: Self.escapedSlashPrefix, in: searchRange)
        return switch (plain, escaped) {
        case let (lhs?, rhs?): lhs.lowerBound <= rhs.lowerBound ? lhs : rhs
        case let (lhs?, nil): lhs
        case let (nil, rhs?): rhs
        case (nil, nil): nil
        }
    }
}
