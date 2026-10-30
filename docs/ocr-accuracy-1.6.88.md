# OCR 1.6.88

The supplied stretched-lettering image had two high-confidence positioned wide reads of MEEEEEEEEEH!!!, but the recovery selector preferred lower-confidence whole-crop reads that collapsed repeated letters and punctuation. Prefer two distinct, high-confidence, spatially agreeing positioned reads before the whole-crop fallback. The source contains nine repeated E glyphs and three exclamation stems.

The DIE!! attachment already had the correct transcription, while its detector group included nearby action lettering. Narrow a single confirmed line only when multiple positioned reads and exactly one detector line support it, and keep excluded line proposals as evidence. On the original full page, keep display-font component proposals separate from ordinary nearby effect proposals before recognition. Reject the clipped DIE! duplicate only with a stronger, independently repeated DIE!! parent covering the same reading, crop-edge evidence, and a wider complete line. Preserve manual decisions and rejected observations.

Both attachments now have the expected text, and full-page 0001.webp has exactly one MEEEEEEEEEH!!! and one DIE!! target region. This checks OCR grouping and selection, not pixel-perfect inpainting ownership or successful reading of the Korean effects. Unrelated low-quality effects elsewhere on that page remain outside the target claim.

Reproduce with npm test, node scripts/check-display-ocr.cjs, and node scripts/benchmark-ocr-accuracy.cjs --phase=after-1.6.88 --full. The comparison report uses saved before/after attachment runs and the saved full-page run.

Validation: 203 general tests pass, syntax passes for 119 desktop JavaScript files, and the existing eight-case/six-image regression retains 11/11 lexical and punctuation-inclusive single-match references. The plant-page text list is unchanged from 1.6.87. Both attachment results and the original full-page target regions pass explicit assertions. The report was rendered and visually inspected. Packaged source verification passes for 137 files.
