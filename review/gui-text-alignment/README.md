# GUI text alignment and Sudoku lesson scrolling — 2026-09-23

- Checkbox, radio, input value/placeholder, and each tree row now use single-line, vertically centered text. Long labels are clipped, not unexpectedly wrapped.
- Tooltips preserve wrapping/newlines and center the entire text block. Overflow remains top-aligned so the beginning remains readable.
- Sudoku removes the obsolete lesson up/down buttons and uses GuiScrollView. The entire text remains available by touch drag/wheel; changing steps resets scrolling.

Verification:
- GUI runtime + scroll/help tests: 19 passed, including glyph vertex positions at 0.6×, 1×, 2× and tooltip wrap/newline/overflow cases.
- Engine repository typecheck passed. Repository tests: 1,304 passed (112 shader-language, 653 Engine, 139 animation-spec, 393 extensions, 7 example catalog).
- Module boundaries, responsibilities, renderer prepare contracts passed.
- API gate remains blocked by the pre-existing @haiyue/ui capability entrypoints/package exports mismatch.
- Focused Engine build, GUI-runtime example build, Sudoku web build, Games typecheck/8 GUI tests, Native typecheck/14 tests passed.
- Browser/WebGPU GUI runtime visually checked: checkbox/radio/input/tree and the button tooltip centered; no warning/error logs.
- Android build installed; 47 GUI smoke checks passed, including long lesson dragging, next/previous reset, hint apply/undo and restored persistence. Normal player save restored.
- Android screenshot/journals: Native/examples/led-sudoku/evidence/gui-alignment (sibling repository).
- iPhone unavailable; no installation claimed for this turn.
- Repository `build`: shader-language, Engine, animation-spec, extensions built successfully. Stopped the remaining 95-example sweep to avoid unrelated rebuilds; focused gui-runtime was already built and visually verified. Full all-example build is not claimed.
- An initial overlapping Engine build/test run failed on transient missing dist chunks; the subsequent serial repository test run passed all 1,304 tests above.
