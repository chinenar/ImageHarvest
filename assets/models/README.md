# Comic text detector

`comic-text-detector.onnx` is the pretrained Comic Text Detector model from
[dmMaze/comic-text-detector](https://github.com/dmMaze/comic-text-detector).
The upstream project is licensed under GPL-3.0; the license is included as
`comic-text-detector.LICENSE`.

Downloaded from the upstream integration release:
https://github.com/zyddnys/manga-image-translator/releases/download/beta-0.2.1/comictextdetector.pt.onnx

SHA-256: `1a86ace74961413cbd650002e7bb4dcec4980ffa21b2f19b86933372071d718f`

Inference uses ONNX Runtime locally. Images and recognized text are not uploaded.
`src/comic-text-detector.cjs` implements resizing, decoding, suppression and
geometric text grouping. The learned block is a text container, not a traced
speech balloon boundary. Keep uncertain and rejected observations for review.
