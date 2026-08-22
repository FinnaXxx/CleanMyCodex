import Foundation

/// The bits of `~/.codex/config.toml` the cleaner has to respect.
///
/// Marketplaces with `source_type = "local"` point at a directory Codex loads plugins from
/// right now. The bundled one lives under `~/.codex/.tmp/bundled-marketplaces/openai-bundled`,
/// which looks like scratch space but is the live source for every `@openai-bundled` plugin.
/// Nothing a marketplace declares as its source may be offered for cleanup.
struct CodexConfiguration: Sendable {
    let localMarketplaceSources: [URL]

    init(localMarketplaceSources: [URL] = []) {
        self.localMarketplaceSources = localMarketplaceSources.map(\.standardizedFileURL)
    }

    static func load(codexHome: URL) -> CodexConfiguration {
        let url = codexHome.appending(path: "config.toml")
        guard let text = try? String(contentsOf: url, encoding: .utf8) else {
            return CodexConfiguration()
        }
        return CodexConfiguration(
            localMarketplaceSources: marketplaceSources(inTOML: text)
                .map { resolve($0, relativeTo: codexHome) }
        )
    }

    /// A deliberately small TOML reader: it only looks for `source = "…"` inside a
    /// `[marketplaces.<name>]` table, in either the table-header or the inline-table form.
    /// Anything it fails to understand simply yields no path, and the name-based fallback
    /// in ProtectedPaths still covers the bundled marketplace.
    static func marketplaceSources(inTOML text: String) -> [String] {
        var sources: [String] = []
        var insideMarketplace = false

        for rawLine in text.split(whereSeparator: \.isNewline) {
            var line = rawLine.trimmingCharacters(in: .whitespaces)
            if let comment = line.firstIndex(of: "#"), !line.hasPrefix("\"") {
                line = String(line[line.startIndex..<comment]).trimmingCharacters(in: .whitespaces)
            }
            guard !line.isEmpty else { continue }

            if line.hasPrefix("[") {
                let header = line.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
                insideMarketplace = header == "marketplaces" || header.hasPrefix("marketplaces.")
                continue
            }

            // `marketplaces.openai-bundled = { source_type = "local", source = "…" }`
            if line.hasPrefix("marketplaces.") || insideMarketplace {
                sources += quotedValues(forKey: "source", in: line)
            }
        }
        return sources
    }

    private static func quotedValues(forKey key: String, in line: String) -> [String] {
        var results: [String] = []
        var search = line[...]
        while let range = search.range(of: key) {
            let before = range.lowerBound == search.startIndex
                ? nil
                : search[search.index(before: range.lowerBound)]
            let rest = search[range.upperBound...]
            // Reject `source_type`, `sources`, `my_source` … only a bare `source` key counts.
            let isBareKey = (before == nil || before == " " || before == "{" || before == ",")
                && rest.first(where: { $0 != " " }) == "="
            if isBareKey, let value = firstQuotedString(in: rest) {
                results.append(value)
            }
            search = rest
        }
        return results
    }

    private static func firstQuotedString(in text: Substring) -> String? {
        guard let start = text.firstIndex(of: "\"") else { return nil }
        let rest = text[text.index(after: start)...]
        guard let end = rest.firstIndex(of: "\"") else { return nil }
        let value = String(rest[rest.startIndex..<end])
        return value.isEmpty ? nil : value
    }

    private static func resolve(_ path: String, relativeTo codexHome: URL) -> URL {
        let expanded = (path as NSString).expandingTildeInPath
        if expanded.hasPrefix("/") { return URL(fileURLWithPath: expanded).standardizedFileURL }
        return codexHome.appending(path: expanded).standardizedFileURL
    }
}
