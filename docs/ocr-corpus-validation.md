# Desktop OCR corpus checks

Run `npm run test:ocr:corpus -- "C:\path\to\images"` to inventory local JPG, PNG, WebP and AVIF images and run full-page enhanced OCR on one representative page per chapter directory. The default folder is `C:\Users\jinna\Downloads\manga test ocr`. The models process images locally.

Use `--case=case-14,case-18` to repeat particular pages, or `--resume` to reuse a successful result only when both the image digest and OCR implementation digest match. The manifest and JSON results are saved under the ignored `test-results/manga-corpus` directory. Errors retain the last progress event and worker diagnostics.

Run `npm run review:ocr:corpus -- --decode` to fully decode every inventoried image and create `review.html`. The review shows source image boxes, selected text, confidence, rejected proposals and alternative readings. Orange boxes require review. Full image decoding checks file integrity; it does not run OCR on every inventoried image.

These samples have no reference transcription. Region counts and model confidence cannot establish text accuracy or whole-page completeness. Inspect small kana, repeated letters in screams, stylized sound effects and adjacent columns against the source. The original readings and coordinates remain available for correction.

Vertical Paddle readings group fragments top to bottom and columns right to left. Japanese Manga OCR answers retain small kana when another reading supports them; a higher score from another model alone cannot erase that evidence. Squeezed Latin lettering uses a wider crop only as a recovery pass, requires agreement and remains marked for review. Wide-crop polygons are mapped back to the original image.
