# Mixed-language small text and source marks, 1.6.75

Small Japanese table regions on an English manga page previously went through the English-only recognizer. The engine now checks small detector-supported CJK candidates with two local multilingual reads. Agreement, confidence, and substantial script evidence are required before changing the region's recognition language. Numeric values and ordinary Latin dialogue do not qualify. Han-only evidence preserves Japanese/Chinese ambiguity rather than inventing a language identification.

The language change remains local to the region. Alternatives and language evidence remain available for review. Enlarging the recognition crop further was tested and made the skill-list transcription worse, so the existing 1000-pixel width cap is retained.

For split Latin dialogue, independently detected complete line bounds now preserve trailing ink in the recognition mask. Explicit shared-row cut edges still prevent the neighboring speaker from being pulled back in. This restores the final period in the three-unit angled-dialogue example.

OCR Lab now offers an explicit sound-effect category. Marking a region as an effect preserves its source text, removes stale translation, and excludes it from translation even when uncertain-box translation is enabled. Restoring the dialogue category is reversible. **This is a manual classification control, not a completed automatic SFX classifier.**

## Evidence

- `test/fixtures/ocr-table-reference.json` freezes two manually transcribed table regions.
- `node scripts/report-ocr-table.cjs` generates before/after source evidence and exact character-edit counts in `test-results/ocr-accuracy/table-report.html` and `table-comparison.json`.
- `node test/ocr-effects.e2e.cjs` checks the real editor's effect category, preservation of source, stale-translation removal, and reversal.
- Unit checks cover mixed-script agreement, rejection of digit/Latin/low-confidence guesses, preservation of shared-row cuts, and translation exclusion.

The two table references contain 143 normalized, non-whitespace characters. Character edit distance falls from 86 to 2: all four right-hand labels match, while the skill list still omits `ム` from `アイテムボックス` and `動` from `魔力自動回復`. The three angled-dialogue phrases are exact including punctuation in the completed GPU page run. General tests pass 172/172; targeted OCR tests pass 37/37; the real effect-category editor check passes. Packaged source verification matches 121 files.

The table remains imperfect: some skill-name characters and other labels are unresolved. The reference areas are development examples, not whole-table or whole-corpus accuracy. Whole-page GPU validation slowed under near-full VRAM. A CPU whole-page attempt exceeded 14 minutes and was interrupted too. Final table verification isolates recognition and routing on two frozen 1.6.74 model proposals on GPU; it does not test full-page detection. This is not a controlled CPU/GPU speed comparison and does not change the application's GPU setting.
